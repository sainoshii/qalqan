import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataset } from "@/lib/dataset";
import { detectLanguage } from "@/lib/detector/rules";

/** Определение языка: казахский узнаётся и в латинице, и в «упрощённых» буквах. Примеры синтетические. */
describe("detectLanguage", () => {
  it.each([
    "Kodty aitynyz, shotynyz bugattalady",
    "Salem, bankten jazyp otyrmyn. Aqshanyz qauipte",
    "Акшанызды кауипсиз шотка аударыныз, бул ушин код керек",
    "Сизге код келеди, маган жибериниз",
    "Сәлеметсіз бе, бұл банк",
  ])("казахский: %s", (text) => {
    expect(detectLanguage(text)).toBe("kk");
  });

  it.each([
    "Здравствуйте, это банк",
    "Zdravstvuite, eto sluzhba bezopasnosti banka. Prodiktuite kod",
    "Внизу страницы нажмите кнопку, бар на углу закрыт",
    "privet, my na basseine uje",
  ])("русский: %s", (text) => {
    expect(detectLanguage(text)).toBe("ru");
  });

  it("на dev-наборах не путает русский с казахским больше, чем раньше", () => {
    const items = ["messages", "challenge-1", "train-2", "train-3"].flatMap((f) =>
      parseDataset(readFileSync(`data/dataset/${f}.jsonl`, "utf8")).items,
    );
    const wrong = (lang: "ru" | "kk") => items.filter((i) => i.lang === lang && detectLanguage(i.text) !== lang).length;
    // До этой задачи: 1 русское определялось как казахское, 8 казахских — как русские
    expect(wrong("ru")).toBeLessThanOrEqual(1);
    expect(wrong("kk")).toBeLessThan(8);
  });
});
