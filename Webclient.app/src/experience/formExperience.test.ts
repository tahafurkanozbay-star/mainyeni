import { createFormExperience, type FieldIssue } from "./formExperience";

const setup = () => {
    document.body.innerHTML = `
        <form id="form">
            <label id="name-label" for="name">Ad</label>
            <p id="name-hint">En az iki karakter</p>
            <input aria-label="Test control" id="name" />
            <p id="name-error"></p>
            <label id="district-label" for="district">İlçe</label>
            <select aria-label="Test control" id="district"><option value="">Seçin</option><option value="cankaya">Çankaya</option></select>
            <p id="district-error"></p>
            <button type="submit">Kaydet</button>
        </form>
        <section id="summary"></section>
        <div id="live"></div>`;
    return {
        form: document.querySelector("#form") as HTMLFormElement,
        name: document.querySelector("#name") as HTMLInputElement,
        nameLabel: document.querySelector("#name-label") as HTMLLabelElement,
        nameHint: document.querySelector("#name-hint") as HTMLElement,
        nameError: document.querySelector("#name-error") as HTMLElement,
        district: document.querySelector("#district") as HTMLSelectElement,
        districtLabel: document.querySelector("#district-label") as HTMLLabelElement,
        districtError: document.querySelector("#district-error") as HTMLElement,
        summary: document.querySelector("#summary") as HTMLElement,
        live: document.querySelector("#live") as HTMLElement
    };
};

afterEach(() => document.body.replaceChildren());

describe("FormExperience registration", () => {
    test("connects label, hint, error and required semantics", () => {
        const view = setup();
        const experience = createFormExperience({ form: view.form, summary: view.summary, liveRegion: view.live });
        experience.register({ id: "name", control: view.name, label: view.nameLabel, hint: view.nameHint, error: view.nameError, required: true });
        expect(view.nameLabel.htmlFor).toBe("name");
        expect(view.name.getAttribute("aria-required")).toBe("true");
        expect(view.name.getAttribute("aria-describedby")).toBe("name-hint");
        expect(view.name.getAttribute("aria-invalid")).toBe("false");
        expect(view.nameError.hidden).toBe(true);
        expect(view.summary.getAttribute("role")).toBe("alert");
        expect(view.live.getAttribute("aria-live")).toBe("polite");
        experience.destroy();
    });

    test("rejects blank and duplicate ids", () => {
        const view = setup();
        const experience = createFormExperience({ form: view.form });
        expect(() => experience.register({ id: " ", control: view.name })).toThrow(/id/);
        experience.register({ id: "name", control: view.name });
        expect(() => experience.register({ id: "name", control: view.district })).toThrow(/kayıtlı/);
        experience.destroy();
    });
});

describe("FormExperience validation", () => {
    test("reports required fields and wires the error description", async () => {
        const view = setup();
        const experience = createFormExperience({ form: view.form, summary: view.summary, liveRegion: view.live });
        experience.register({ id: "name", control: view.name, hint: view.nameHint, error: view.nameError, required: true });
        const snapshot = await experience.validate();
        expect(snapshot.valid).toBe(false);
        expect(snapshot.fields[0]?.issues[0]?.code).toBe("required");
        expect(view.name.getAttribute("aria-invalid")).toBe("true");
        expect(view.name.getAttribute("aria-describedby")).toContain("name-error");
        expect(view.nameError.textContent).toContain("zorunludur");
        experience.destroy();
    });

    test("supports synchronous custom validation", async () => {
        const view = setup();
        view.name.value = "A";
        const experience = createFormExperience({ form: view.form });
        experience.register({
            id: "name",
            control: view.name,
            validate: (value) => value.length < 2 ? { code: "short", message: "En az iki karakter girin." } : null
        });
        expect((await experience.validate()).fields[0]?.state).toBe("invalid");
        view.name.value = "An";
        expect((await experience.validate()).fields[0]?.state).toBe("valid");
        experience.destroy();
    });

    test("supports multiple issues", async () => {
        const view = setup();
        const issues: FieldIssue[] = [{ code: "one", message: "Birinci" }, { code: "two", message: "İkinci" }];
        const experience = createFormExperience({ form: view.form });
        experience.register({ id: "name", control: view.name, error: view.nameError, validate: () => issues });
        await experience.validate();
        expect(view.nameError.textContent).toBe("Birinci İkinci");
        experience.destroy();
    });

    test("isolates thrown validation failures as field errors", async () => {
        const view = setup();
        const experience = createFormExperience({ form: view.form });
        experience.register({ id: "name", control: view.name, validate: () => { throw new Error("Servis doğrulaması başarısız"); } });
        const snapshot = await experience.validate();
        expect(snapshot.fields[0]?.issues[0]?.message).toBe("Servis doğrulaması başarısız");
        experience.destroy();
    });

    test("setIssues supports server-side validation results", () => {
        const view = setup();
        const experience = createFormExperience({ form: view.form });
        experience.register({ id: "name", control: view.name, error: view.nameError });
        experience.setIssues("name", { code: "duplicate", message: "Bu kayıt zaten var." });
        expect(experience.snapshot().valid).toBe(false);
        expect(view.nameError.textContent).toContain("zaten var");
        experience.setIssues("name", null);
        expect(experience.snapshot().valid).toBe(true);
        experience.destroy();
    });
});

describe("async validation lifecycle", () => {
    test("aborts stale validation when a newer run starts", async () => {
        const view = setup();
        const signals: AbortSignal[] = [];
        let resolveFirst: ((value: FieldIssue | null) => void) | undefined;
        const first = new Promise<FieldIssue | null>((resolve) => { resolveFirst = resolve; });
        let call = 0;
        const experience = createFormExperience({ form: view.form });
        experience.register({
            id: "name",
            control: view.name,
            validate: (_value, signal) => {
                signals.push(signal);
                call += 1;
                return call === 1 ? first : Promise.resolve(null);
            }
        });
        const pending = experience.validate("name");
        const latest = experience.validate("name");
        await latest;
        expect(signals[0]?.aborted).toBe(true);
        resolveFirst?.({ code: "stale", message: "Eski hata" });
        await pending;
        expect(experience.snapshot().fields[0]?.state).toBe("valid");
        experience.destroy();
    });

    test("exposes validating state while async work is pending", async () => {
        const view = setup();
        let resolve: (() => void) | undefined;
        const gate = new Promise<void>((done) => { resolve = done; });
        const experience = createFormExperience({ form: view.form });
        experience.register({ id: "name", control: view.name, validate: async () => { await gate; return null; } });
        const pending = experience.validate();
        await Promise.resolve();
        expect(experience.snapshot().validating).toBe(true);
        expect(view.name.getAttribute("aria-busy")).toBe("true");
        resolve?.();
        await pending;
        expect(experience.snapshot().validating).toBe(false);
        experience.destroy();
    });
});

describe("summary and interaction state", () => {
    test("renders linked error summary content and live announcement", async () => {
        const view = setup();
        const experience = createFormExperience({ form: view.form, summary: view.summary, liveRegion: view.live });
        experience.register({ id: "name", control: view.name, error: view.nameError, required: true });
        experience.register({ id: "district", control: view.district, error: view.districtError, required: true });
        await experience.validate();
        expect(view.summary.textContent).toContain("2 alanda");
        expect(view.summary.querySelectorAll("button")).toHaveLength(2);
        expect(view.live.textContent).toContain("2 form hatası");
        experience.destroy();
    });

    test("tracks dirty and touched state", async () => {
        const view = setup();
        const experience = createFormExperience({ form: view.form });
        experience.register({ id: "name", control: view.name });
        view.name.value = "Ankara";
        view.name.dispatchEvent(new Event("input", { bubbles: true }));
        expect(experience.snapshot().fields[0]?.dirty).toBe(true);
        view.name.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        await Promise.resolve();
        expect(experience.snapshot().fields[0]?.touched).toBe(true);
        experience.destroy();
    });

    test("reset clears interaction and validation state", () => {
        const view = setup();
        const experience = createFormExperience({ form: view.form, summary: view.summary, liveRegion: view.live });
        experience.register({ id: "name", control: view.name, error: view.nameError });
        experience.setIssues("name", { code: "x", message: "Hata" });
        experience.reset();
        expect(experience.snapshot().fields[0]).toMatchObject({ state: "idle", dirty: false, touched: false, issues: [] });
        expect(view.summary.textContent).toBe("");
        expect(view.live.textContent).toBe("");
        experience.destroy();
    });

    test("unregister removes a field from snapshots", () => {
        const view = setup();
        const experience = createFormExperience({ form: view.form });
        const dispose = experience.register({ id: "name", control: view.name });
        dispose();
        expect(experience.snapshot().fields).toHaveLength(0);
        experience.destroy();
    });
});
