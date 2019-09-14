import { UserModel } from '../model/types';
import { Idiom, Login, UserRole, ProviderType } from '../_graphql/types';
import { ObjectID } from 'mongodb';
import { Languages } from './languages'

export interface DbIdiom {
    _id?: ObjectID,
    slug: string,
    title: string,
    description: string,
    tags?: string[],
    equivalents?: ObjectID[],

    transliteration?: string;
    literalTranslation?: string;
    languageKey?: string;
    countryKeys?: string[];

    createdById?: ObjectID,
    createdAt?: Date,
    updateById?: ObjectID
    updatedAt?: Date
    isDeleted?: boolean;
}

export interface DbUser {
    _id?: ObjectID,
    name: string,
    avatar: string,
    providers: DbLogin[],
    role?: UserRole
}

export interface DbLogin {
    externalId: string,
    name: string,
    type: ProviderType,
    email?: string,
    avatar?: string
}

export function mapDbUser(dbUser: DbUser): UserModel {
    const userModel = new UserModel();
    userModel.id = dbUser._id.toHexString();
    userModel.name = dbUser.name;
    userModel.avatar = dbUser.avatar;
    userModel.role = dbUser.role;
    userModel.providers = dbUser.providers.map<Login>(p => {
        return {
            externalId: p.externalId,
            name: p.name,
            email: p.email,
            type: p.type,
            avatar: p.avatar
        }
    });

    return userModel;
}

export function mapDbIdiom(dbIdiom: DbIdiom, dbTranslations?: DbIdiom[], users?: UserModel[]): Idiom {

    // The language model will start with all available countries and we want to only have the
    // ones that user's indicated that this idiom makes sense in. Some idioms are culture specific and don't
    // span the same language in different countries
    const languageModel = Languages.Instance.getLangugage(dbIdiom.languageKey);
    const countryModels = dbIdiom.countryKeys ? dbIdiom.countryKeys.map(c => Languages.Instance.getCountry(c)) : [];
    languageModel.countries = countryModels;

    let idiom: Idiom = {
        id: dbIdiom._id.toHexString(),
        slug: dbIdiom.slug,
        title: dbIdiom.title,
        description: dbIdiom.description,
        tags: dbIdiom.tags || [],
        language: languageModel,
        literalTranslation: dbIdiom.literalTranslation,
        transliteration: dbIdiom.transliteration,
        createdAt: dbIdiom.createdAt && dbIdiom.createdAt.toUTCString(),
        updatedAt: dbIdiom.updatedAt && dbIdiom.updatedAt.toUTCString(),
        equivalents: [],
        createdBy: null,
        updatedBy: null
    };

    // NOTE: This should be optimized since its potentially slow...
    if (dbTranslations) {
        idiom.equivalents = dbTranslations.filter(dbt => (dbIdiom.equivalents || []).some(x => dbt._id.equals(x)))
            .map(t => this.mapDbIdiom(t, null, users));
    }

    if (users) {
        const matchingCreatedBy = users.filter(u => u.id === dbIdiom.createdById.toHexString());
        const matchingUpdatedBy = users.filter(u => u.id === dbIdiom.updateById.toHexString());
        idiom.createdBy = matchingCreatedBy ? matchingCreatedBy[0] : null;
        idiom.updatedBy = matchingUpdatedBy ? matchingUpdatedBy[0] : null;
    }

    return idiom;
}