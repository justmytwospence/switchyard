import { type AdapterEffect, AdapterRegistry, type PiUiRequest } from "@switchyard/adapter-sdk";
import { bundledAdapters } from "../src/index.js";

/**
 * Request payloads in the shape pi-ask-user-question and pi-tool-gate send over RPC
 * (`extension_ui_request`, dialog methods). Titles follow the plugins' RPC formatting:
 * ask-user-question `[header] question` plus `--- n. label ---` preview blocks, numbered
 * options with a final "N. Type something."; tool-gate "Allow this call?" plus field lines.
 */

export const fruitQuestion = {
  question: "Which fruit should we use?",
  header: "Fruit",
  options: [
    { label: "Apple", description: "Red and crunchy", preview: "An apple a day" },
    { label: "Banana", description: "Yellow and soft", preview: "Potassium" },
    { label: "Cherry", description: "Small and sweet" },
  ],
};

export const toppingsQuestion = {
  question: "Which toppings?",
  header: "Toppings",
  multiSelect: true,
  options: [
    { label: "Cream", description: "Whipped", preview: "```\ncream\n```" },
    { label: "Nuts", description: "Crunchy" },
    { label: "Syrup", description: "Sweet" },
  ],
};

export const sizeQuestion = {
  question: "What size?",
  header: "Size",
  options: [
    { label: "Small", description: "" },
    { label: "Large", description: "" },
  ],
};

export const fruitSelect: PiUiRequest = {
  id: "aq-1",
  method: "select",
  title:
    "[Fruit] Which fruit should we use?\n\n--- 1. Apple ---\nAn apple a day\n\n--- 2. Banana ---\nPotassium",
  options: [
    "1. Apple - Red and crunchy",
    "2. Banana - Yellow and soft",
    "3. Cherry - Small and sweet",
    "4. Type something.",
  ],
};

export const fruitOtherInput: PiUiRequest = {
  id: "aq-2",
  method: "input",
  title: `${fruitSelect.title}\n\nType your answer:`,
};

export const toppingsInput: PiUiRequest = {
  id: "aq-3",
  method: "input",
  title:
    "[Toppings] Which toppings?\n\n--- 1. Cream ---\n```\ncream\n```\n\n1. Cream - Whipped\n2. Nuts - Crunchy\n3. Syrup - Sweet\n\nEnter the numbers of your choices, separated by commas (e.g. 1,3):",
};

export const sizeSelect: PiUiRequest = {
  id: "aq-4",
  method: "select",
  title: "[Size] What size?",
  options: ["1. Small", "2. Large", "3. Type something."],
};

export const gateSelect: PiUiRequest = {
  id: "tg-1",
  method: "select",
  title: [
    "Allow this call?",
    "Action: run a shell command",
    "Target: rm -rf build",
    "Held: no rule allows this command",
    "Agent: main",
    "This removes files in the workspace.",
    "Rule: bash rm -rf build",
    "Folder: /work/repo",
  ].join("\n"),
  options: [
    "Allow once",
    "Allow rule for this session",
    "Allow rule in this project",
    "Allow rule everywhere",
    "Edit the rule...",
    "Block",
    "Block with a message",
  ],
};

export const gateMessageInput: PiUiRequest = {
  id: "tg-2",
  method: "input",
  title: "Message for the agent",
};

export function harness(sessionId = "ses_test") {
  const effects: AdapterEffect[] = [];
  const registry = new AdapterRegistry();
  registry.setAdapters(bundledAdapters());
  const session = registry.openSession({ sessionId, emit: (e) => effects.push(e) });
  return { registry, session, effects };
}
