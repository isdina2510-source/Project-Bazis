import { useCallback, useState } from "react";
import { useI18n } from "../i18n/I18nProvider.jsx";
import PrivacyModal from "./PrivacyModal.jsx";

/** Чекбокс согласия на обработку ПД со ссылкой на политику конфиденциальности. */
export default function ConsentField({ checked, onChange, className = "" }) {
  const { tRich } = useI18n();
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const closePrivacy = useCallback(() => setPrivacyOpen(false), []);

  return (
    <>
      <label className={"contact-consent" + (className ? " " + className : "")}>
        <input
          type="checkbox"
          name="consent"
          required
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          {tRich("contact.form.consent", {
            link: (chunks) => (
              <button
                type="button"
                key="privacy"
                className="contact-consent-link"
                onClick={(event) => {
                  event.preventDefault();
                  setPrivacyOpen(true);
                }}
              >
                {chunks}
              </button>
            ),
          })}
        </span>
      </label>
      {privacyOpen ? <PrivacyModal onClose={closePrivacy} /> : null}
    </>
  );
}
