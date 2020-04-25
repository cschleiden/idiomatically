import React, { memo, useState } from "react";
import "./WorldIdiomMap.scss";
import ReactTooltip from "react-tooltip";
import {
    ZoomableGroup,
    ComposableMap,
    Geographies,
    Geography
} from "react-simple-maps";
import { GetIdiomQuery_idiom, GetIdiomQuery_idiom_equivalents, GetIdiomQuery_idiom_equivalents_language_countries, GetIdiomQuery_idiom_language_countries } from "../__generated__/types";
import { CountryFlag } from "./CountryFlag";

const geoUrl = `${process.env.REACT_APP_SERVER}/world-110m.json`;

interface MapChartProps extends WorldIdiomMapProps {
    setSelectedCountry: (tooltip: (SelectedCountry | null)) => void;
}

export interface WorldIdiomMapProps {
    idiom: GetIdiomQuery_idiom;
}

type IdiomMapInfo = {
    title: string,
    literalTranslation: string | null,
    languageName: string,
    country: GetIdiomQuery_idiom_equivalents_language_countries | GetIdiomQuery_idiom_language_countries
}

const MapChartInternal: React.StatelessComponent<MapChartProps> = (props) => {


    return (
        <>
            <ComposableMap projection="geoMercator" data-tip="" projectionConfig={{ scale: 135 }}>
                <ZoomableGroup>
                    <Geographies geography={geoUrl}>
                        {({ geographies }) =>
                            geographies.map(geo => {
                                const { NAME, ISO_A2 } = geo.properties;
                                const idioms = idiomMap.get(ISO_A2);
                                const hasIdioms = !!idioms;
                                return <Geography
                                    stroke="white"
                                    strokeWidth="0.5px"
                                    key={geo.rsmKey}
                                    geography={geo}
                                    onMouseEnter={() => {
                                        if (idioms) {
                                            props.setSelectedCountry({
                                                countryKey: ISO_A2,
                                                countryName: NAME
                                            });
                                        }
                                    }}
                                    onMouseLeave={() => {
                                        props.setSelectedCountry(null);
                                    }}
                                    style={{
                                        default: {
                                            fill: hasIdioms ? "#513b56" : "#D6D6DA",
                                            outline: hasIdioms ? "" : "none"
                                        },
                                        hover: {
                                            fill: hasIdioms ? "#525174" : "#D6D6DA",
                                            outline: "none"
                                        },
                                        pressed: {
                                            fill: hasIdioms ? "#525174" : "#D6D6DA",
                                            outline: "none"
                                        }
                                    }}
                                />;
                            })
                        }
                    </Geographies>
                </ZoomableGroup>
            </ComposableMap>
        </>
    );
};

const MapChart = memo(MapChartInternal);

type SelectedCountry = {
    countryKey: string,
    countryName: string
}

const idiomMap: Map<string, IdiomMapInfo[]> = new Map();
const WorldMap: React.StatelessComponent<WorldIdiomMapProps> = (props) => {
    const [selectedCountry, setSelectedCountry] = useState<SelectedCountry | null>(null);
    const newProps = { setSelectedCountry: setSelectedCountry, ...props };

    const idiom = props.idiom;

    // Convert idioms into a map for plotting on a ... map ;)
    if (idiomMap.size === 0) {
        ProcessIdiom(idiomMap, idiom);
        for (const equivIdiom of idiom.equivalents) {
            ProcessIdiom(idiomMap, equivIdiom);
        }
    }

    let toolTipContent: JSX.Element | null = null;
    if (selectedCountry) {
        const idioms = idiomMap.get(selectedCountry?.countryKey);
        const country = idioms ? idioms[0].country : null;
        const idiomHtml = idioms?.map(x =>
            <><div className="mapIdiomTitle">{x.title}</div>
                <div className="mapIdiomTranslation">{x.literalTranslation}</div></>)
        toolTipContent = <div>
            <h2><CountryFlag country={country!} size={"small"} />{selectedCountry.countryName}</h2>
            {idiomHtml}
        </div>;
    }

    return (
        <div className="worldIdiomTooltip">
            <MapChart {...newProps} />
            <ReactTooltip className="worldIdiomTooltip">{toolTipContent}</ReactTooltip>
        </div>
    );
}
function ProcessIdiom(idiomMap: Map<string, IdiomMapInfo[]>, idiom: (GetIdiomQuery_idiom | GetIdiomQuery_idiom_equivalents)) {
    for (let country of idiom.language.countries) {
        let existing = idiomMap.get(country.countryKey) || [];
        const info: IdiomMapInfo = {
            title: idiom.title,
            literalTranslation: idiom.literalTranslation,
            languageName: idiom.language.languageName,
            country: country
        };
        existing.push(info);
        idiomMap.set(country.countryKey, existing);
    }
}

export default WorldMap;