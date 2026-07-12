/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ScriptPickerView } from "../src/script-picker";
import type { PackageScript } from "../src/scripts";

const scripts: PackageScript[] = [
  { packageRoot: "/api", packageName: "api", scriptName: "dev", command: "api-dev" },
  { packageRoot: "/web", packageName: "web", scriptName: "build", command: "web-build" },
];

test("picker toggles scripts with keyboard navigation and confirms selection", async () => {
  let selected: PackageScript[] | undefined;
  const setup = await testRender(<ScriptPickerView scripts={scripts} onConfirm={(value) => { selected = value; }} onCancel={() => {}} />, { width: 80, height: 12 });
  try {
    await setup.flush();
    await act(async () => { setup.mockInput.pressKey("space"); });
    await act(async () => { setup.mockInput.pressKey("j"); });
    await act(async () => { setup.mockInput.pressKey("space"); });
    await act(async () => { setup.mockInput.pressEnter(); });
    expect(selected).toEqual(scripts);
  } finally {
    await act(async () => { setup.renderer.destroy(); });
  }
});

test("picker selects every script with a", async () => {
  let selected: PackageScript[] | undefined;
  const setup = await testRender(<ScriptPickerView scripts={scripts} onConfirm={(value) => { selected = value; }} onCancel={() => {}} />, { width: 80, height: 12 });
  try {
    await setup.flush();
    await act(async () => { setup.mockInput.pressKey("a"); });
    await act(async () => { setup.mockInput.pressEnter(); });
    expect(selected).toEqual(scripts);
  } finally {
    await act(async () => { setup.renderer.destroy(); });
  }
});
