import { Db, Collection, ObjectID, FilterQuery } from 'mongodb'
import { Idiom, IdiomCreateInput, IdiomUpdateInput, QueryIdiomsArgs, OperationResult, IdiomOperationResult, OperationStatus, QueryIdiomArgs, IdiomChangeProposal, QueryIdiomChangeProposalsArgs } from '../_graphql/types';
import { Languages } from './languages'
import { UserModel, IdiomExpandOptions } from '../model/types';
import { DbIdiom, mapDbIdiom, DbIdiomChangeProposal, IdiomProposalType } from './mapping';
import { transliterate, slugify } from 'transliteration';
import { escapeRegex } from './utils';
import { UserDataProvider } from './userDataProvider';

export type Paged<T> = {
    result: T[],
    limit: number,
    skip: number,
    count: number,
    totalCount: number
}

export class IdiomDataProvider {

    private changeProposalCollection: Collection<DbIdiomChangeProposal>;
    private idiomCollection: Collection<DbIdiom>;

    private activeIdiomFilter: FilterQuery<DbIdiom> = { isDeleted: { $ne: true } };

    constructor(private mongodb: Db, private userDataProvider: UserDataProvider, collectionPrefix: string) {
        this.changeProposalCollection = mongodb.collection(collectionPrefix + 'idiomChangeProposal');

        this.idiomCollection = mongodb.collection(collectionPrefix + 'idiom');

        // Not supported in CosmoDB Mongo facade
        //this.idiomCollection.createIndex({ title: "text" });
        //this.idiomCollection.createIndex({ description: "text" });
    }

    /**
     * Converts a idiom filter into one that excludes deleted and provisional idioms
     * @param idiomFilter A filter to extend to active idioms only
     */
    private activeOnly(idiomFilter: FilterQuery<DbIdiom>): FilterQuery<DbIdiom> {
        const active = this.activeIdiomFilter;

        if (idiomFilter) {
            if (idiomFilter instanceof ObjectID) {
                idiomFilter = { _id: { $eq: idiomFilter } };
            }
            return { $and: [active, idiomFilter] };
        }
        else {
            return active;
        }
    }

    async queryIdiomChangeProposals(args: QueryIdiomChangeProposalsArgs): Promise<Paged<IdiomChangeProposal>> {
        const filter = args && args.filter ? args.filter : undefined;
        const limit = args && args.limit ? args.limit : 50;
        let skip = args && args.cursor && Number.parseInt(args.cursor);
        if (isNaN(skip)) {
            skip = 0;
        }

        let totalCount = null;
        let dbProposals: DbIdiomChangeProposal[];
        let findFilter: FilterQuery<DbIdiom>;
        let sortObj: object = { createdAt: -1 };

        if (filter) {
            const filterQuery = { type: { $eq: filter } };
            findFilter = filterQuery;
        }

        totalCount = await this.changeProposalCollection.countDocuments(findFilter);
        dbProposals = await this.changeProposalCollection
            .find(findFilter)
            .sort(sortObj)
            .skip(skip)
            .limit(limit)
            .toArray();


        return {
            totalCount: totalCount,
            limit: limit,
            skip: skip,
            count: dbProposals.length,
            result: dbProposals.map<IdiomChangeProposal>(proposal => { return { id: proposal._id.toHexString(), body: JSON.stringify(proposal) } })
        };
    }

    async deleteIdiom(currentUser: UserModel, idiomId: string): Promise<OperationResult> {
        if (!idiomId) {
            throw new Error("Invalid idiomId");
        }

        const objectId = new ObjectID(idiomId);

        if (this.isUserProvisional(currentUser)) {
            const proposal: DbIdiomChangeProposal = {
                userId: new ObjectID(currentUser.id),
                createdAt: new Date(new Date().toUTCString()),
                type: IdiomProposalType.DeleteIdiom,
                idiomId: objectId
            };
            const provisionalResult = await this.changeProposalCollection.insertOne(proposal);
            return this.operationResult(OperationStatus.Pending);
        }
        else {
            const deleteResult = await this.idiomCollection.deleteOne({ _id: objectId });
            await this.idiomCollection.updateMany({ equivalents: objectId }, { $pull: { equivalents: objectId } });

            return deleteResult && deleteResult.deletedCount && deleteResult.deletedCount > 0
                ? this.operationResult(OperationStatus.Success) : this.operationResult(OperationStatus.Failure);
        }
    }

    async createIdiom(currentUser: UserModel, createInput: IdiomCreateInput, idiomExpandOptions: IdiomExpandOptions): Promise<IdiomOperationResult> {
        if (!currentUser || !currentUser.id) {
            throw new Error("Could not find current user");
        }

        if (!createInput || !createInput.title) {
            throw new Error("Invalid idiom");
        }

        if (!createInput.languageKey || !Languages.Instance.hasLangugage(createInput.languageKey)) {
            throw new Error("languageKey is not valid");
        }

        if (!createInput.countryKeys
            || createInput.countryKeys.length <= 0
            || createInput.countryKeys.some(countryKey => !Languages.Instance.hasCountry(countryKey, createInput.languageKey))) {
            throw new Error("countryKey is not valid");
        }

        createInput.countryKeys = Array.from(new Set(createInput.countryKeys));

        // Check if this is a dupe
        let idiomSlug = slugify(createInput.title);
        if (!idiomSlug) {
            throw new Error("Unable to general idiom slug");
        }

        var dbIdiom: DbIdiom = {
            title: createInput.title,
            slug: idiomSlug,
            description: createInput.description,
            tags: createInput.tags,
            languageKey: Languages.Instance.normalizeLanguageKey(createInput.languageKey),
            countryKeys: createInput.countryKeys,
            transliteration: createInput.transliteration,
            literalTranslation: createInput.literalTranslation,
            createdAt: new Date(new Date().toUTCString()),
            createdById: new ObjectID(currentUser.id)
        };

        this.validateAndNormalize(true, dbIdiom);

        // Look for dupe titles or slugs
        const titleRegex = "^" + escapeRegex(createInput.title) + "$";
        const titleRegexObj = { $regex: titleRegex, $options: 'i' };
        const dupeFilter = this.activeOnly({ $or: [{ title: titleRegexObj }, { slug: { $eq: idiomSlug } }] });
        const dupeIdioms = await this.idiomCollection.find(dupeFilter).toArray();
        if (dupeIdioms) {

            // If dupe title, throw. Ideally this could be a fuzzy smart match in the future
            if (dupeIdioms.some(idiom => idiom.title === createInput.title)) {
                throw new Error("This idiom already exists");
            }

            // We could technically de-dupe the slug but I am not sure a real scenario exists here
            // where we get dupe so will handle when it arised.
            if (dupeIdioms.some(idiom => idiom.slug === idiomSlug)) {
                throw new Error("This idiom slug exists");
            }
        }

        if (this.isUserProvisional(currentUser)) {
            const proposal: DbIdiomChangeProposal = {
                userId: new ObjectID(currentUser.id),
                createdAt: new Date(new Date().toUTCString()),
                type: IdiomProposalType.CreateIdiom,
                idiomToCreate: dbIdiom
            };
            const provisionalResult = await this.changeProposalCollection.insertOne(proposal);
            return this.idiomOperationResult(OperationStatus.Pending);
        }
        else {

            const result = await this.idiomCollection.insertOne(dbIdiom);

            if (result.insertedCount <= 0) {
                throw new Error("Failed to insert idiom");
            }

            if (createInput.relatedIdiomId) {
                await this.addIdiomEquivalent(currentUser, result.insertedId, createInput.relatedIdiomId);
            }

            const resIdiom = await this.getIdiom(result.insertedId, idiomExpandOptions);
            return this.idiomOperationResult(OperationStatus.Success, resIdiom);
        }
    }

    async updateIdiom(currentUser: UserModel, updateInput: IdiomUpdateInput, idiomExpandOptions: IdiomExpandOptions): Promise<IdiomOperationResult> {
        if (!currentUser || !currentUser.id) {
            throw new Error("Could not find current user");
        }

        if (!updateInput || !updateInput.id) {
            throw new Error("Invalid idiom");
        }

        const objId = new ObjectID(updateInput.id);
        const dbIdiom = await this.getDbIdiom(objId);

        const updates: Partial<DbIdiom> = {};
        for (const key of Object.keys(updateInput)) {
            const value = updateInput[key];
            if (value !== undefined) {
                updates[key] = value;
            }
        }

        // Set the language key since we don't let you change it
        updates.languageKey = dbIdiom.languageKey;

        this.validateAndNormalize(false, updates);

        if (updates.title && updateInput.title !== dbIdiom.title) {
            const titleRegex = "^" + escapeRegex(updates.title) + "$";
            const titleRegexObj = { $regex: titleRegex, $options: 'i' };
            const dupeFilter = this.activeOnly({ title: titleRegexObj, _id: { $ne: objId } });
            const dupeIdioms = await this.idiomCollection.find(dupeFilter).toArray();
            if (dupeIdioms) {
                // If dupe title, throw. Ideally this could be a fuzzy smart match in the future
                if (dupeIdioms.some(idiom => idiom.title === updates.title)) {
                    throw new Error("This idiom already exists");
                }
            }
        }

        updates.updatedAt = new Date(new Date().toUTCString());
        updates.updateById = new ObjectID(currentUser.id);
        if (this.isUserProvisional(currentUser)) {
            const proposal: DbIdiomChangeProposal = {
                userId: new ObjectID(currentUser.id),
                createdAt: new Date(new Date().toUTCString()),
                type: IdiomProposalType.UpdateIdiom,
                idiomToUpdate: updates
            };
            const provisionalResult = await this.changeProposalCollection.insertOne(proposal);
            return this.idiomOperationResult(OperationStatus.Pending);
        }
        else {

            const result = await this.idiomCollection.updateOne({ _id: objId }, { $set: updates });

            if (result.matchedCount <= 0) {
                throw new Error("Failed to update idiom");
            }

            const resIdiom = await this.getIdiom(objId, idiomExpandOptions);
            return this.idiomOperationResult(OperationStatus.Success, resIdiom);
        }
    }

    private validateAndNormalize(isNew: boolean, updates: Partial<DbIdiom>) {

        const isEnglish = updates.languageKey.toLocaleLowerCase() === "en";

        if (updates.title !== undefined) {
            if (updates.title.length > 1000) {
                throw new Error("Title is too long")
            }

            // If new and you do not supply a transliteration, auto-gen one
            if (isNew && !updates.transliteration && !isEnglish) {
                updates.transliteration = transliterate(updates.title);
            }
        }

        if (updates.description !== undefined) {
            if (updates.title.length > 10000) {
                throw new Error("Description is too long")
            }
        }

        if (updates.transliteration !== undefined) {
            if (updates.transliteration.length > 1000) {
                throw new Error("Transliteration is too long")
            }
        }

        if (updates.literalTranslation !== undefined) {
            if (updates.literalTranslation.length > 1000) {
                throw new Error("LiteralTranslation is too long")
            }
        }

        // If you are not english, require literalTranslation
        if (!isEnglish) {
            const invalidUpdate = !isNew && updates.literalTranslation !== undefined && !updates.literalTranslation;
            const invalidCreate = isNew && !updates.literalTranslation;
            if (invalidUpdate || invalidCreate) {
                throw new Error("An English literal translation is needed for non-English idioms")
            }
        }

        // Normalize tags
        if (updates.tags !== undefined) {
            updates.tags = updates.tags || [];
            updates.tags = updates.tags.map(t => t.toLowerCase());
        }

        // Validate if we are updating the country keys
        if (updates.countryKeys) {
            if (updates.countryKeys.length <= 0) {
                throw new Error("You must specify at least one valid country");
            }

            const invalidCountries = updates.countryKeys.filter(c => !Languages.Instance.hasCountry(c, updates.languageKey));
            if (invalidCountries.length > 0) {
                throw new Error(`The follow countries are not valid for the idioms language: ${invalidCountries.join(',')}`);
            }

            // normalize
            updates.countryKeys = updates.countryKeys.map(c => Languages.Instance.getCountry(c).countryKey);
        }
    }

    private async getDbIdiom(args: QueryIdiomArgs | ObjectID): Promise<DbIdiom> {

        let query: FilterQuery<DbIdiom>;
        if (args instanceof ObjectID) {
            query = args;
        }
        else if (args.id) {
            query = new ObjectID(args.id);
        }
        else if (args.slug) {
            query = { slug: { $eq: args.slug } };
        }

        query = this.activeOnly(query);
        return await this.idiomCollection.findOne(query);
    }

    async getIdiom(args: QueryIdiomArgs | ObjectID, idiomExpandOptions?: IdiomExpandOptions): Promise<Idiom> {
        const dbIdiom = await this.getDbIdiom(args);
        let dbEquivalents: DbIdiom[] = [];
        let users: UserModel[] = [];

        if (dbIdiom) {
            if (idiomExpandOptions && idiomExpandOptions.expandEquivalents) {
                const equivalentObjIds = (dbIdiom.equivalents || []).map(id => new ObjectID(id));

                const equivalentQuery = this.activeOnly({ _id: { $in: equivalentObjIds } });
                dbEquivalents = await this.idiomCollection.find(equivalentQuery).toArray();
            }

            if (idiomExpandOptions && idiomExpandOptions.expandUsers) {
                const userIds = dbEquivalents.flatMap(t => [t.createdById, t.updateById]).concat(dbIdiom.createdById, dbIdiom.updateById);
                users = await this.userDataProvider.getUsers(userIds);
            }

            return mapDbIdiom(dbIdiom, dbEquivalents, users);
        }
    }

    async queryIdioms(args: QueryIdiomsArgs, idiomExpandOptions: IdiomExpandOptions): Promise<Paged<Idiom>> {
        const filter = args && args.filter ? args.filter : undefined;
        const limit = args && args.limit ? args.limit : 50;
        const locale = args && args.locale ? args.locale : undefined;
        let skip = args && args.cursor && Number.parseInt(args.cursor);
        if (isNaN(skip)) {
            skip = 0;
        }

        let totalCount = null;
        let dbIdioms: DbIdiom[];
        let findFilter: FilterQuery<DbIdiom>;
        let sortObj: object = { createdAt: -1 };
        let users: UserModel[];

        if (locale) {
            const localeRegex = "^" + escapeRegex(locale);
            findFilter = { locale: { $regex: localeRegex } };
        }

        if (filter) {
            const filterRegex = escapeRegex(filter);
            const filterRegexObj = { $regex: filterRegex, $options: 'i' };
            const filterQuery: FilterQuery<DbIdiom> = { $or: [{ title: filterRegexObj }, { description: filterRegexObj }, { literalTranslation: filterRegexObj }] };
            if (findFilter) {
                findFilter = { $and: [findFilter, filterQuery] };
            }
            else {
                findFilter = filterQuery;
            }

            sortObj = { title: 1 };
        }

        findFilter = this.activeOnly(findFilter);
        totalCount = await this.idiomCollection.countDocuments(findFilter);

        dbIdioms = await this.idiomCollection
            .find(findFilter)
            .sort(sortObj)
            .skip(skip)
            .limit(limit)
            .toArray();


        let dbEquivalents: DbIdiom[] = [];
        if (dbIdioms) {
            if (idiomExpandOptions.expandEquivalents) {
                const equivalentsObjIds = dbIdioms.flatMap(dbIdiom => (dbIdiom.equivalents || []).map(id => new ObjectID(id)));
                const equivalentQuery = this.activeOnly({ _id: { $in: equivalentsObjIds } });
                dbEquivalents = await this.idiomCollection.find(equivalentQuery).toArray();
            }

            if (idiomExpandOptions.expandUsers) {
                const userIds = dbIdioms.flatMap(t => [t.createdById, t.updateById]).concat(dbEquivalents.flatMap(t => [t.createdById, t.updateById]));
                users = await this.userDataProvider.getUsers(userIds);
            }
        }

        return {
            totalCount: totalCount,
            limit: limit,
            skip: skip,
            count: dbIdioms.length,
            result: dbIdioms.map(idiom => mapDbIdiom(idiom, dbEquivalents, users))
        };
    }

    async removeIdiomEquivalent(currentUser: UserModel, idiomId: string, equivalentId: string): Promise<OperationResult> {
        if (!idiomId || !equivalentId) {
            throw new Error("Empty id passed");
        }

        const idiomObjId = new ObjectID(idiomId);
        const equivalentObjId = new ObjectID(equivalentId);
        const objIds = [idiomObjId, equivalentObjId];
        const dbIdioms = await this.idiomCollection.find({ _id: { $in: objIds } }).toArray();
        if (dbIdioms.length < 2) {
            throw new Error("Failed to resolve both idioms");
        }

        if (this.isUserProvisional(currentUser)) {
            const proposal: DbIdiomChangeProposal = {
                userId: new ObjectID(currentUser.id),
                createdAt: new Date(new Date().toUTCString()),
                type: IdiomProposalType.DeleteEquivalent,
                idiomId: idiomObjId,
                equivalentId: equivalentObjId
            };
            const provisionalResult = await this.changeProposalCollection.insertOne(proposal);
            return this.operationResult(OperationStatus.Pending);
        }
        else {
            var bulk = this.idiomCollection.initializeOrderedBulkOp();
            bulk.find({ _id: idiomObjId }).updateOne({ $pull: { equivalents: equivalentObjId } });
            bulk.find({ _id: equivalentObjId }).updateOne({ $pull: { equivalents: idiomObjId } });
            const result = await bulk.execute();
            return !result.hasWriteErrors() ? this.operationResult(OperationStatus.Success) : this.operationResult(OperationStatus.Failure);
        }

    }

    async addIdiomEquivalent(currentUser: UserModel, idiomId: string | ObjectID, equivalentId: string | ObjectID): Promise<OperationResult> {
        if (!idiomId || !equivalentId) {
            throw new Error("Empty id passed");
        }

        const idiomObjId = new ObjectID(idiomId);
        const equivalentObjId = new ObjectID(equivalentId);
        const objIds = [idiomObjId, equivalentObjId];
        const dbIdioms = await this.idiomCollection.find({ _id: { $in: objIds } }).toArray();
        if (dbIdioms.length < 2) {
            throw new Error("Fails to resolve both idioms");
        }

        if (this.isUserProvisional(currentUser)) {
            const proposal: DbIdiomChangeProposal = {
                userId: new ObjectID(currentUser.id),
                createdAt: new Date(new Date().toUTCString()),
                type: IdiomProposalType.AddEquivalent,
                idiomId: idiomObjId,
                equivalentId: equivalentObjId
            };
            const provisionalResult = await this.changeProposalCollection.insertOne(proposal);
            return this.operationResult(OperationStatus.Pending);
        }
        else {
            var bulk = this.idiomCollection.initializeOrderedBulkOp();
            bulk.find({ _id: idiomObjId }).updateOne({ $addToSet: { equivalents: equivalentObjId } });
            bulk.find({ _id: equivalentObjId }).updateOne({ $addToSet: { equivalents: idiomObjId } });
            const result = await bulk.execute();

            return !result.hasWriteErrors() ? this.operationResult(OperationStatus.Success) : this.operationResult(OperationStatus.Failure);
        }
    }

    private idiomOperationResult(status: OperationStatus, idiom?: Idiom, message?: string): IdiomOperationResult {
        if (status == OperationStatus.Pending) {
            message = message || "Change is pending approval, thanks!";
        }
        return {
            status: status,
            message: message,
            idiom: idiom
        };
    }

    private operationResult(status: OperationStatus, message?: string): OperationResult {
        if (status == OperationStatus.Pending) {
            message = message || "Change is pending approval, thanks!";
        }
        return {
            status: status,
            message: message
        };
    }

    private isUserProvisional(currentUser: UserModel) {
        return !currentUser.hasEditPermission();
    }
}