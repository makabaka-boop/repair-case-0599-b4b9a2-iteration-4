import { describe, expect, it } from "vitest";
import { EMPTY_FORM } from "./types";
import { formToPayload, validateComponent, validateForm } from "./validation";

describe("validateComponent", () => {
  it("接受端点值（闭区间）", () => {
    expect(validateComponent("standard", "L", "0")).toBeNull();
    expect(validateComponent("standard", "L", "100")).toBeNull();
    expect(validateComponent("sample", "a", "-128")).toBeNull();
    expect(validateComponent("sample", "a", "127")).toBeNull();
    expect(validateComponent("sample", "b", "-128")).toBeNull();
    expect(validateComponent("sample", "b", "127")).toBeNull();
  });

  it("拒绝缺失（空串/空白）", () => {
    expect(validateComponent("standard", "L", "")).not.toBeNull();
    expect(validateComponent("standard", "L", "   ")).not.toBeNull();
  });

  it("拒绝非有限值 NaN / Infinity", () => {
    for (const v of ["NaN", "nan", "Infinity", "-Infinity", "+inf"]) {
      expect(validateComponent("standard", "b", v), v).not.toBeNull();
    }
  });

  it("拒绝非数字与越界值", () => {
    expect(validateComponent("standard", "L", "五十")).not.toBeNull();
    expect(validateComponent("standard", "L", "-0.001")).not.toBeNull();
    expect(validateComponent("standard", "L", "100.01")).not.toBeNull();
    expect(validateComponent("sample", "a", "-129")).not.toBeNull();
    expect(validateComponent("sample", "b", "128")).not.toBeNull();
  });

  it("允许前后空白与小数", () => {
    expect(validateComponent("standard", "a", " 2.5 ")).toBeNull();
    expect(validateComponent("standard", "b", "-1e1")).toBeNull();
  });
});

describe("validateForm", () => {
  it("完整合法表单返回空错误表", () => {
    const form = {
      standard: { L: "50", a: "2.6772", b: "-79.7751" },
      sample: { L: "50", a: "0", b: "-82.7485" },
    };
    expect(validateForm(form)).toEqual({});
  });

  it("任意字段错误都整次拒绝", () => {
    const form = {
      standard: { L: "50", a: "", b: "-79" },
      sample: { L: "50", a: "0", b: "200" },
    };
    const errors = validateForm(form);
    expect(errors["standard.a"]).toBeTruthy();
    expect(errors["sample.b"]).toBeTruthy();
  });

  it("空表单六字段全部报错", () => {
    expect(Object.keys(validateForm(EMPTY_FORM))).toHaveLength(6);
  });
});

describe("formToPayload", () => {
  it("把字符串转成数值请求体", () => {
    const payload = formToPayload({
      standard: { L: "60.2574", a: "-34.0099", b: "36.2677" },
      sample: { L: "60.4626", a: "-34.1751", b: "39.4387" },
    });
    expect(payload).toEqual({
      standard: { L: 60.2574, a: -34.0099, b: 36.2677 },
      sample: { L: 60.4626, a: -34.1751, b: 39.4387 },
    });
  });
});
