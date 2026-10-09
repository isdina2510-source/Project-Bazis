import { useState } from "react";
import { quizMaxScore, quizResult } from "../content/articles.js";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { localizedField } from "../i18n/index.js";
import ArticleCta from "./ArticleCta.jsx";

/** Короткий тест: по вопросу на экран, в конце результат с рекомендацией услуги. */
export default function Quiz({ test }) {
  const { lang, t } = useI18n();
  const [answers, setAnswers] = useState([]);
  const total = test.questions.length;
  const step = answers.length;
  const done = step >= total;

  if (done) {
    const score = answers.reduce((sum, value) => sum + value, 0);
    const max = quizMaxScore(test);
    const result = quizResult(test, score);
    const resultTitle = localizedField(result, "title", lang);
    return (
      <div className="quiz quiz-result" aria-live="polite">
        <p className="quiz-score">{t("articles.quiz.score", { score, max })}</p>
        <div className="quiz-meter" aria-hidden="true">
          <span style={{ width: Math.round((score / max) * 100) + "%" }} />
        </div>
        <h2>{resultTitle}</h2>
        <p>{localizedField(result, "text", lang)}</p>
        <button type="button" className="quiz-restart" onClick={() => setAnswers([])}>
          {t("articles.quiz.restart")}
        </button>
        <ArticleCta
          eyebrow={t("articles.quiz.recommend")}
          productId={result.productId}
          articleTitle={localizedField(test, "title", lang)}
          quiz={{ score, max, result: resultTitle }}
        />
      </div>
    );
  }

  const question = test.questions[step];
  return (
    <div className="quiz">
      <div className="quiz-head">
        <p className="quiz-progress">{t("articles.quiz.progress", { current: step + 1, total })}</p>
        {step > 0 && (
          <button type="button" className="quiz-back" onClick={() => setAnswers((list) => list.slice(0, -1))}>
            {t("articles.quiz.prev")}
          </button>
        )}
      </div>
      <div className="quiz-meter" aria-hidden="true">
        <span style={{ width: Math.round((step / total) * 100) + "%" }} />
      </div>
      <fieldset className="quiz-question" key={step}>
        <legend>{localizedField(question, "q", lang)}</legend>
        {question.options.map((option, index) => (
          <button
            type="button"
            key={index}
            className="quiz-option"
            onClick={() => setAnswers((list) => [...list, option.score])}
          >
            {localizedField(option, "text", lang)}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
