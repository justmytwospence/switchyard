import type { Field } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  buildValues,
  chooseSelect,
  chooseSelectOther,
  initialFormState,
  toggleMulti,
  validateForm,
  visibleFields,
} from "../src/components/intent/formLogic";

const fields: Field[] = [
  {
    kind: "select",
    name: "q1",
    label: "Fruit",
    options: [
      { value: "Apple", label: "Apple" },
      { value: "Pear", label: "Pear" },
    ],
    allowOther: { label: "Other" },
  },
  {
    kind: "multiselect",
    name: "q2",
    label: "Letters",
    options: ["A", "B", "C"].map((v) => ({ value: v, label: v })),
    min: 1,
    max: 2,
  },
  {
    kind: "text",
    name: "why",
    label: "Why pear?",
    prefill: "because",
    showIf: { field: "q1", values: ["Pear"] },
  },
];

describe("FormRenderer logic", () => {
  it("produces structured values without comma entry", () => {
    let st = initialFormState(fields);
    st = { ...st, q1: chooseSelect(st.q1!, "Apple") };
    st = { ...st, q2: toggleMulti(st.q2!, "A", 2) };
    st = { ...st, q2: toggleMulti(st.q2!, "C", 2) };
    expect(validateForm(fields, st)).toEqual({});
    expect(buildValues(fields, st)).toEqual({ q1: "Apple", q2: ["A", "C"] });
  });

  it("enforces multiselect max and min", () => {
    let st = initialFormState(fields);
    st = { ...st, q1: chooseSelect(st.q1!, "Apple") };
    expect(validateForm(fields, st).q2).toBe("Choose at least 1");
    for (const v of ["A", "B", "C"]) st = { ...st, q2: toggleMulti(st.q2!, v, 2) };
    expect(st.q2!.selected).toEqual(["A", "B"]);
    st = { ...st, q2: toggleMulti(st.q2!, "A", 2) };
    expect(st.q2!.selected).toEqual(["B"]);
  });

  it("requires a select choice and non-empty other text", () => {
    let st = initialFormState(fields);
    st = { ...st, q2: toggleMulti(st.q2!, "A") };
    expect(validateForm(fields, st).q1).toBe("Choose an option");
    st = { ...st, q1: chooseSelectOther(st.q1!) };
    expect(validateForm(fields, st).q1).toBeDefined();
    st = { ...st, q1: { ...st.q1!, otherText: "Kiwi" } };
    expect(validateForm(fields, st)).toEqual({});
    expect(buildValues(fields, st).q1).toEqual({ other: "Kiwi" });
  });

  it("shows dependent fields via showIf and omits hidden ones", () => {
    let st = initialFormState(fields);
    st = { ...st, q1: chooseSelect(st.q1!, "Apple"), q2: toggleMulti(st.q2!, "B") };
    expect(visibleFields(fields, st).map((f) => f.name)).toEqual(["q1", "q2"]);
    expect(buildValues(fields, st)).not.toHaveProperty("why");
    st = { ...st, q1: chooseSelect(st.q1!, "Pear") };
    expect(visibleFields(fields, st).map((f) => f.name)).toEqual(["q1", "q2", "why"]);
    expect(buildValues(fields, st).why).toBe("because");
  });
});
