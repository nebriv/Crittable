export const WIZARD_STEPS = [
  { id: 1, name: "Scenario" },
  { id: 2, name: "Environment" },
  { id: 3, name: "Roles" },
  { id: 4, name: "Injects & schedule" },
  { id: 5, name: "Invite players" },
  { id: 6, name: "Review & launch" },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];
