import { describe, expect, it } from "vitest";
import { featurize, normalizeForModel } from "@/lib/detector/features";

/** Признаки модели не зависят от записи: латиница, «упрощённые» буквы и смешанная раскладка дают те же n-граммы. */
const keys = (t: string) => [...featurize(t).keys()].sort((a, b) => a - b);

describe("признаки модели строятся по скелету текста", () => {
  it.each([
    ["Кодты айтыңыз, шотыңыз бұғатталады", "Kodty aitynyz, shotynyz bugattalady"],
    ["Кодты айтыңыз, шотыңыз бұғатталады", "Кодты айтыныз, шотыныз бугатталады"],
    ["Кодты айтыңыз, шотыңыз бұғатталады", "Koдты aйтыңыз, шoтыңыз бұғaттaлaды"],
    ["Ақшаны қауіпсіз шотқа аударыңыз", "Aqshany qauipsiz shotqa audarynyz"],
    ["Продиктуйте код из SMS", "Prodiktuite kod iz SMS"],
  ])("%s = %s", (a, b) => {
    expect(keys(b)).toEqual(keys(a));
  });

  it("ссылки, цифры и регистр — как раньше", () => {
    expect(normalizeForModel("Перейдите: https://bank-x.example/a?b=1 КОД 4821")).toBe("перейдите ссылка код 0");
    expect(normalizeForModel("Silteme: kaspi-bonus.top/kz, 5000 tg")).toBe("силтеме ссылка 0 тг");
  });

  it("русский текст в кириллице даёт те же признаки, что и раньше", () => {
    expect(normalizeForModel("Служба безопасности: срочно переведите 50 000 на безопасный счёт!")).toBe("служба безопасности срочно переведите 0 0 на безопасный счет");
  });
});
