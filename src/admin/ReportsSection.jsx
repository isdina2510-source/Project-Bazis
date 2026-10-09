import { useMemo, useState } from "react";
import { STATUS_LABELS, isLead } from "./format.js";
import RefreshButton from "./RefreshButton.jsx";
import {
  CHANNELS,
  GROUPINGS,
  KINDS,
  PERIOD_PRESETS,
  REPORT_TYPES,
  buildReport,
  currenciesOf,
  defaultFilters,
  presetRange,
} from "./reports/build.js";
import { StaleBuildError, exportCsv, exportPdf, exportXlsx, formatCell, printReport } from "./reports/export.js";

const PREVIEW_LIMIT = 200;

const FORMATS = [
  { id: "pdf", label: "PDF", run: exportPdf, fill: true },
  { id: "xlsx", label: "Excel", run: exportXlsx, fill: true },
  { id: "csv", label: "CSV", run: exportCsv },
  { id: "print", label: "Печать", run: printReport },
];

function toggle(list, value) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function CheckGroup({ legend, options, value, onChange }) {
  return (
    <fieldset className="rep-field rep-checks">
      <legend>{legend}</legend>
      <div className="crm-filters">
        {Object.keys(options).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={value.includes(key)}
            className={"crm-filter" + (value.includes(key) ? " is-active" : "")}
            onClick={() => onChange(toggle(value, key))}
          >
            {options[key]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export default function ReportsSection({ orders, clients, products, loadError, onRefresh }) {
  const [filters, setFilters] = useState(defaultFilters);
  const [preset, setPreset] = useState("30d");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);

  const set = (patch) => setFilters((prev) => ({ ...prev, ...patch }));
  const currencies = useMemo(() => currenciesOf(orders.filter((order) => !isLead(order))), [orders]);
  const report = useMemo(
    () => buildReport({ orders, clients, products, filters }),
    [orders, clients, products, filters]
  );
  const activeType = REPORT_TYPES.find((item) => item.id === filters.type);
  const isLeads = filters.type === "leads";

  const applyPreset = (id) => {
    setPreset(id);
    set(presetRange(id));
  };

  const runExport = async (format) => {
    setBusy(format.id);
    setError(null);
    try {
      await format.run(report);
    } catch (err) {
      console.error("Экспорт " + format.label + ":", err);
      if (err instanceof StaleBuildError) {
        setError({
          text: "Админка обновилась на сервере, а эта вкладка открыта со старой версией. Обновите страницу и повторите экспорт.",
          reload: true,
        });
      } else {
        const detail = err && err.message ? " Причина: " + err.message : "";
        setError({ text: "Не удалось сформировать " + format.label + "." + detail });
      }
    } finally {
      setBusy("");
    }
  };

  const isNumeric = (type) => type === "number" || type === "money" || type === "percent";
  const preview = report.rows.slice(0, PREVIEW_LIMIT);

  return (
    <section id="reports-section" className="dash-card dash-card-full">
      <div className="crm-toolbar">
        <div>
          <h2>Отчёты</h2>
          <p className="admin-hint">Выберите вид отчёта и параметры, затем скачайте его в нужном формате.</p>
        </div>
        <RefreshButton onRefresh={onRefresh} />
      </div>

      <div className="rep-types" role="tablist" aria-label="Вид отчёта">
        {REPORT_TYPES.map((type) => (
          <button
            key={type.id}
            type="button"
            role="tab"
            aria-selected={filters.type === type.id}
            className={"rep-type" + (filters.type === type.id ? " is-active" : "")}
            onClick={() => set({ type: type.id })}
          >
            <strong>{type.label}</strong>
            <span>{type.hint}</span>
          </button>
        ))}
      </div>

      <div className="rep-filters">
        <fieldset className="rep-field rep-period">
          <legend>Период</legend>
          <div className="crm-filters">
            {PERIOD_PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={"crm-filter" + (preset === item.id ? " is-active" : "")}
                onClick={() => applyPreset(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="rep-dates">
            <label>
              <span>с</span>
              <input
                type="date"
                value={filters.from}
                max={filters.to || undefined}
                onChange={(event) => {
                  setPreset("");
                  set({ from: event.target.value });
                }}
              />
            </label>
            <label>
              <span>по</span>
              <input
                type="date"
                value={filters.to}
                min={filters.from || undefined}
                onChange={(event) => {
                  setPreset("");
                  set({ to: event.target.value });
                }}
              />
            </label>
          </div>
        </fieldset>

        <CheckGroup
          legend="Статусы"
          options={STATUS_LABELS}
          value={filters.statuses}
          onChange={(statuses) => set({ statuses })}
        />
        {!isLeads && (
          <CheckGroup
            legend="Каналы"
            options={CHANNELS}
            value={filters.channels}
            onChange={(channels) => set({ channels })}
          />
        )}

        <div className="rep-row">
          {!isLeads && (
            <label className="rep-field">
              <span>Тип позиций</span>
              <select value={filters.kind} onChange={(event) => set({ kind: event.target.value })}>
                <option value="all">Все</option>
                {Object.keys(KINDS).map((key) => (
                  <option key={key} value={key}>
                    {KINDS[key]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {filters.type === "periods" && (
            <label className="rep-field">
              <span>Группировка</span>
              <select value={filters.grouping} onChange={(event) => set({ grouping: event.target.value })}>
                {Object.keys(GROUPINGS).map((key) => (
                  <option key={key} value={key}>
                    {GROUPINGS[key]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!isLeads && currencies.length > 1 && (
            <label className="rep-field">
              <span>Валюта</span>
              <select
                value={filters.currency || currencies[0]}
                onChange={(event) => set({ currency: event.target.value })}
              >
                {currencies.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="rep-field rep-search">
            <span>{isLeads ? "Имя или телефон" : "Клиент"}</span>
            <input
              type="search"
              placeholder="Имя или телефон"
              autoComplete="off"
              value={filters.search}
              onChange={(event) => set({ search: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="dash-btn rep-reset"
            onClick={() => {
              setFilters(defaultFilters());
              setPreset("30d");
            }}
          >
            Сбросить
          </button>
        </div>
      </div>

      <div className="rep-summary">
        {report.summary.map((item) => (
          <div key={item.label} className="rep-stat">
            <span>{item.label}</span>
            <strong>{formatCell(item.value, item.type, report.currency)}</strong>
          </div>
        ))}
      </div>

      <div className="rep-export">
        <p className="admin-hint">
          {activeType ? activeType.label : ""} · строк: {report.rows.length}
        </p>
        <div className="crm-card-actions">
          {FORMATS.map((format) => (
            <button
              key={format.id}
              type="button"
              className={"dash-btn" + (format.fill ? " dash-btn-fill" : "")}
              disabled={!!busy}
              onClick={() => runExport(format)}
            >
              {busy === format.id ? "Готовим…" : format.label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="admin-error" role="alert">
          {error.text}
          {error.reload && (
            <>
              {" "}
              <button type="button" className="dash-btn" onClick={() => window.location.reload()}>
                Обновить страницу
              </button>
            </>
          )}
        </p>
      )}

      {loadError ? (
        <p className="crm-empty">Не удалось загрузить заказы. Проверьте сервер и нажмите «Обновить».</p>
      ) : !report.rows.length ? (
        <p className="crm-empty">Нет данных по выбранным параметрам.</p>
      ) : (
        <div className="rep-table-wrap">
          <table className="rep-table">
            <thead>
              <tr>
                {report.columns.map((col) => (
                  <th key={col.key} className={isNumeric(col.type) ? "is-num" : ""}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.map((row, i) => (
                <tr key={i}>
                  {report.columns.map((col) => (
                    <td key={col.key} className={isNumeric(col.type) ? "is-num" : col.wrap ? "is-wrap" : ""}>
                      {formatCell(row[col.key], col.type, report.currency)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {report.totals && (
              <tfoot>
                <tr>
                  {report.columns.map((col) => (
                    <td key={col.key} className={isNumeric(col.type) ? "is-num" : ""}>
                      {formatCell(report.totals[col.key], col.type, report.currency)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
          {report.rows.length > PREVIEW_LIMIT && (
            <p className="admin-hint">
              Показаны первые {PREVIEW_LIMIT} строк из {report.rows.length}. В файл попадут все.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
