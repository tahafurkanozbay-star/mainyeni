import {
    ADDRESS_LEVELS_V2,
    ADDRESS_TOKEN_CLASS,
    ADDRESS_QUERY_VERSION,
    analyzeAddressQuery,
    canonicalizeAddressText,
    canonicalizeAddressToken,
    canonicalizeAddressTokens,
    classifyAddressToken,
    createAddressQuerySignature,
    createAddressTokenDescriptor,
    createDocumentSemanticFields,
    evaluateAddressEvidence,
    normalizeAddressSemanticText,
    parseAddressNumberToken,
    scoreAddressDocumentSemantic,
    scoreSemanticToken,
    summarizeAddressAnalysis,
    tokenizeAddressSemanticText
} from "./AddressQuerySemanticsRuntime";
import {
    createAddressCandidatePlan,
    createFallbackAddressPlan,
    createPlannerDiagnostics,
    getPositionsForDistrict,
    getPositionsForNeighborhood,
    getPositionsForStreet,
    getPositionsForToken,
    getTokenLookupVariants,
    inferPlannerLevel,
    intersectSets,
    materializeAddressCandidates,
    unionSets,
    validateAddressCandidatePlan
} from "./AddressCandidatePlannerRuntime";
import { createAddressIndex } from "./AddressSearchRuntime";

const fixtures = [
    { id: "district-cankaya", level: "district", title: "Çankaya", district: "Çankaya" },
    { id: "district-mamak", level: "district", title: "Mamak", district: "Mamak" },
    {
        id: "neighborhood-ayranci",
        level: "neighborhood",
        title: "Ayrancı Mahallesi",
        district: "Çankaya",
        neighborhood: "Ayrancı"
    },
    {
        id: "neighborhood-kavaklidere",
        level: "neighborhood",
        title: "Kavaklıdere Mahallesi",
        district: "Çankaya",
        neighborhood: "Kavaklıdere"
    },
    {
        id: "street-hosdere",
        level: "street",
        title: "Hoşdere Caddesi",
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Hoşdere Caddesi"
    },
    {
        id: "street-tunali",
        level: "street",
        title: "Tunalı Hilmi Caddesi",
        district: "Çankaya",
        neighborhood: "Kavaklıdere",
        street: "Tunalı Hilmi Caddesi"
    },
    {
        id: "street-gunes",
        level: "street",
        title: "Güneş Sokak",
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Güneş Sokak"
    },
    {
        id: "door-hosdere-10",
        level: "door",
        title: "Hoşdere 10",
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Hoşdere Caddesi",
        door: "10"
    },
    {
        id: "door-hosdere-100",
        level: "door",
        title: "Hoşdere 100",
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Hoşdere Caddesi",
        door: "100"
    },
    {
        id: "door-gunes-10",
        level: "door",
        title: "Güneş 10",
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Güneş Sokak",
        door: "10"
    }
];

const index = createAddressIndex(fixtures);

const find = id => index.byId.get(id);

describe("AddressQuerySemanticsRuntime", () => {
    test("publishes a deterministic semantic contract version", () => {
        expect(ADDRESS_QUERY_VERSION).toBe("2.0.0");
        expect(Object.values(ADDRESS_LEVELS_V2)).toEqual(expect.arrayContaining([
            "district", "neighborhood", "street", "building", "door", "address"
        ]));
    });

    test.each([
        ["Cd.", "cadde"],
        ["CAD", "cadde"],
        ["Caddesi", "cadde"],
        ["Sk.", "sokak"],
        ["Sokağı", "sokak"],
        ["Blv.", "bulvar"],
        ["Bulvarı", "bulvar"],
        ["Mah.", "mahalle"],
        ["Mahallesi", "mahalle"],
        ["Kapı", "no"],
        ["Numarası", "no"],
        ["Apt.", "apartman"]
    ])("canonicalizes Turkish address alias %s", (input, expected) => {
        expect(canonicalizeAddressToken(input)).toBe(expected);
    });

    test("keeps normalization locale-safe and punctuation-insensitive", () => {
        expect(normalizeAddressSemanticText("  ÇİĞDEM Mh., 12/A  ")).toBe("cigdem mh 12 a");
        expect(tokenizeAddressSemanticText("Hoşdere Cd./No: 10")).toEqual([
            "hosdere", "cd", "no", "10"
        ]);
        expect(canonicalizeAddressTokens("Hoşdere Cd. Caddesi")).toEqual(["hosdere", "cadde"]);
        expect(canonicalizeAddressText("Tunalı Hilmi Caddesi")).toBe("tunali hilmi cadde");
    });

    test("classifies structural, strong, number and postal-code evidence", () => {
        expect(classifyAddressToken("cadde")).toBe(ADDRESS_TOKEN_CLASS.Structural);
        expect(classifyAddressToken("Hoşdere")).toBe(ADDRESS_TOKEN_CLASS.Strong);
        expect(classifyAddressToken("10")).toBe(ADDRESS_TOKEN_CLASS.Number);
        expect(classifyAddressToken("06680")).toBe(ADDRESS_TOKEN_CLASS.PostalCode);
        expect(createAddressTokenDescriptor("Sk.")).toEqual(expect.objectContaining({
            canonical: "sokak",
            isStructural: true,
            isRoadType: true
        }));
    });

    test("parses exact door-number tokens without substring ambiguity", () => {
        expect(parseAddressNumberToken("12A")).toEqual(expect.objectContaining({ number: 12, suffix: "a" }));
        expect(parseAddressNumberToken("100")).toEqual(expect.objectContaining({ number: 100, suffix: "" }));
        expect(parseAddressNumberToken("12/A")).toBeNull();
        expect(parseAddressNumberToken("abc")).toBeNull();
    });

    test("infers street level for road designators", () => {
        const analysis = analyzeAddressQuery("Hoşdere Cd.");
        expect(analysis.inferredLevel).toBe(ADDRESS_LEVELS_V2.Street);
        expect(analysis.strongTokens).toEqual(["hosdere"]);
        expect(analysis.roadTokens).toEqual(["cadde"]);
        expect(analysis.weakOnly).toBe(false);
    });

    test("infers door level when road query contains an exact number", () => {
        const analysis = analyzeAddressQuery("Hoşdere Caddesi No 10");
        expect(analysis.hasDoorHint).toBe(true);
        expect(analysis.inferredLevel).toBe(ADDRESS_LEVELS_V2.Door);
        expect(analysis.numericTokens).toEqual(["10"]);
        expect(analysis.requiresNumericEvidence).toBe(true);
    });

    test("recognizes weak structural-only queries without pretending they are strong evidence", () => {
        const analysis = analyzeAddressQuery("cadde");
        expect(analysis.weakOnly).toBe(true);
        expect(analysis.strongTokens).toEqual([]);
        expect(analysis.structuralTokens).toEqual(["cadde"]);
        expect(analysis.requiresStrongEvidence).toBe(false);
    });

    test("creates stable query signatures from canonical aliases", () => {
        const left = createAddressQuerySignature(analyzeAddressQuery("Hoşdere Cd."), { district: "Çankaya" });
        const right = createAddressQuerySignature(analyzeAddressQuery("hosdere caddesi"), { district: "CANKAYA" });
        expect(left).toBe(right);
    });

    test("summarizes query characteristics without exposing mutable internals", () => {
        expect(summarizeAddressAnalysis("Hoşdere Cd. 10")).toEqual(expect.objectContaining({
            canonicalText: "hosdere cadde 10",
            strongTokenCount: 1,
            structuralTokenCount: 1,
            numericTokenCount: 1,
            hasDoorHint: true,
            inferredLevel: "door"
        }));
    });

    test("builds semantic fields from normalized address documents", () => {
        const semantic = createDocumentSemanticFields(find("door-hosdere-10"));
        expect(semantic.fieldTokens.street).toEqual(expect.arrayContaining(["hosdere", "cadde"]));
        expect(semantic.fieldTokens.door).toContain("10");
        expect(semantic.allTokens).toEqual(expect.arrayContaining(["hosdere", "cadde", "10", "cankaya"]));
    });

    test("scores exact strong tokens above prefixes and substrings", () => {
        expect(scoreSemanticToken("hosdere", "hosdere")).toBeGreaterThan(scoreSemanticToken("hosdere", "hos"));
        expect(scoreSemanticToken("hosdere", "dere")).toBeGreaterThan(0);
        expect(scoreSemanticToken("cadde", "cadde", ADDRESS_TOKEN_CLASS.Structural)).toBe(15);
    });

    test("requires strong evidence when a query contains strong terms", () => {
        const unrelated = find("street-tunali");
        const evidence = evaluateAddressEvidence(unrelated, "bilinmeyen cadde");
        expect(evidence.strongSatisfied).toBe(false);
        expect(evidence.eligible).toBe(false);
        expect(scoreAddressDocumentSemantic(unrelated, "bilinmeyen cadde").score).toBe(0);
    });

    test("keeps structural-only search possible without treating it as a name match", () => {
        const hosdere = find("street-hosdere");
        const evidence = evaluateAddressEvidence(hosdere, "cadde");
        expect(evidence.eligible).toBe(true);
        expect(evidence.matchedStructural.length).toBeGreaterThan(0);
        expect(scoreAddressDocumentSemantic(hosdere, "cadde").score).toBeGreaterThan(0);
    });

    test("requires exact numeric evidence for door queries", () => {
        const ten = scoreAddressDocumentSemantic(find("door-hosdere-10"), "Hoşdere Cd 10");
        const hundred = scoreAddressDocumentSemantic(find("door-hosdere-100"), "Hoşdere Cd 10");
        expect(ten.score).toBeGreaterThan(0);
        expect(hundred.score).toBe(0);
    });

    test("penalizes road-type mismatch while retaining strong-name evidence", () => {
        const street = find("street-gunes");
        const sameType = scoreAddressDocumentSemantic(street, "Güneş Sokak");
        const wrongType = scoreAddressDocumentSemantic(street, "Güneş Cadde");
        expect(sameType.score).toBeGreaterThan(wrongType.score);
        expect(wrongType.roadTypeMismatch).toBe(true);
        expect(wrongType.score).toBeGreaterThan(0);
    });
});

describe("AddressCandidatePlannerRuntime", () => {
    test("unions and intersects candidate sets deterministically", () => {
        expect(Array.from(unionSets([new Set([1, 2]), new Set([2, 3])]))).toEqual([1, 2, 3]);
        expect(Array.from(intersectSets([new Set([1, 2, 3]), new Set([2, 3, 4]), new Set([3, 5])]))).toEqual([3]);
    });

    test("expands canonical road tokens to indexed aliases", () => {
        expect(getTokenLookupVariants("Cd.")).toEqual(expect.arrayContaining(["cadde", "cd", "caddesi"]));
        const positions = getPositionsForToken(index, "Cd.");
        expect(positions.size).toBeGreaterThan(0);
        expect(Array.from(positions).map(position => index.documents[position].id)).toContain("street-hosdere");
    });

    test("uses hierarchy maps for district, neighborhood and street constraints", () => {
        expect(getPositionsForDistrict(index, "Çankaya").size).toBe(fixtures.length - 1);
        expect(getPositionsForNeighborhood(index, "Çankaya", "Ayrancı").size).toBeGreaterThan(0);
        expect(getPositionsForStreet(index, "Çankaya", "Ayrancı", "Hoşdere Caddesi").size).toBe(3);
    });

    test("plans strong street searches from indexed token evidence", () => {
        const plan = createAddressCandidatePlan(index, "Hoşdere Cd.", { district: "Çankaya" });
        const ids = materializeAddressCandidates(index, plan).map(item => item.document.id);
        expect(plan.strategy).toMatch(/index/);
        expect(plan.effectiveLevel).toBe("street");
        expect(ids).toEqual(["street-hosdere"]);
        expect(plan.selectivity).toBeLessThan(1);
    });

    test("intersects exact number evidence with strong token evidence", () => {
        const plan = createAddressCandidatePlan(index, "Hoşdere Cd. 10");
        const ids = materializeAddressCandidates(index, plan).map(item => item.document.id);
        expect(plan.effectiveLevel).toBe("door");
        expect(ids).toEqual(["door-hosdere-10"]);
        expect(ids).not.toContain("door-hosdere-100");
        expect(ids).not.toContain("door-gunes-10");
    });

    test("returns no indexed candidates for unknown strong terms instead of scanning all records", () => {
        const plan = createAddressCandidatePlan(index, "bilinmeyen cadde");
        expect(plan.strategy).toBe("empty-index-result");
        expect(plan.positions).toEqual([]);
        expect(plan.candidateCount).toBe(0);
    });

    test("keeps weak structural queries bounded by their token index", () => {
        const plan = createAddressCandidatePlan(index, "cadde", { district: "Çankaya" });
        const ids = materializeAddressCandidates(index, plan).map(item => item.document.id);
        expect(ids).toEqual(expect.arrayContaining(["street-hosdere", "street-tunali"]));
        expect(ids).not.toContain("street-gunes");
    });

    test("does not full-scan strong misses even when weak fallback is enabled", () => {
        const plan = createAddressCandidatePlan(index, "yok cadde");
        const fallback = createFallbackAddressPlan(index, plan, { allowWeakFullScan: true });
        expect(fallback.positions).toEqual([]);
        expect(fallback.strategy).toBe("empty-index-result");
    });

    test("can explicitly bound a structural-only full scan fallback", () => {
        const synthetic = {
            ...createAddressCandidatePlan(index, "cadde"),
            positions: [],
            candidateCount: 0
        };
        const fallback = createFallbackAddressPlan(index, synthetic, {
            allowWeakFullScan: true,
            maxCandidates: 3
        });
        expect(fallback.strategy).toBe("bounded-full-scan-fallback");
        expect(fallback.positions).toHaveLength(3);
        expect(fallback.truncated).toBe(true);
    });

    test("validates candidate positions and catches out-of-range plans", () => {
        const plan = createAddressCandidatePlan(index, "Hoşdere");
        expect(validateAddressCandidatePlan(index, plan)).toEqual([]);
        expect(validateAddressCandidatePlan(index, { ...plan, positions: [999], candidateCount: 1 }))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ code: "candidate-out-of-range", severity: "error" })
            ]));
    });

    test("reports planner diagnostics without serializing sets", () => {
        const plan = createAddressCandidatePlan(index, "Hoşdere Cd.");
        expect(createPlannerDiagnostics(plan)).toEqual(expect.objectContaining({
            strategy: expect.any(String),
            candidateCount: expect.any(Number),
            totalCount: fixtures.length,
            truncated: false
        }));
    });

    test.each([
        ["Hoşdere Cd.", {}, "street"],
        ["Hoşdere Cd. 10", {}, "door"],
        ["Ayrancı Mah.", {}, "neighborhood"],
        ["anything", { level: "district" }, "district"]
    ])("infers planner level for %s", (query, options, expected) => {
        expect(inferPlannerLevel(query, options)).toBe(expected);
    });
});