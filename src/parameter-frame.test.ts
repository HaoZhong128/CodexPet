// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { applyParameterFrame } from "./live2d";

describe("applyParameterFrame", () => {
  it("writes only parameters present in the loaded model and clamps their ranges", () => {
    const values = [0, 0];
    const coreModel = {
      getParameterCount: () => 2,
      getParameterId: (index: number) => ({
        getString: () => ({ s: ["ParamAngleX", "ParamEyeLOpen"][index] }),
      }),
      getParameterMinimumValue: (index: number) => (index === 0 ? -30 : 0),
      getParameterMaximumValue: (index: number) => (index === 0 ? 30 : 1),
      setParameterValueByIndex: vi.fn((index: number, value: number) => {
        values[index] = value;
      }),
    };

    applyParameterFrame(coreModel, {
      ParamAngleX: 50,
      ParamEyeLOpen: -1,
      ParamSwordAngle: 20,
    });

    expect(values).toEqual([30, 0]);
    expect(coreModel.setParameterValueByIndex).toHaveBeenCalledTimes(2);
  });
});
