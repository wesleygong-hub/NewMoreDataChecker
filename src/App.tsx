import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import packageInfo from "../package.json";
import niumaLogo from "./assets/niuma-reconcile-logo.png";
import type {
  ImportIssue,
  ExportWorkerRequest,
  ExportWorkerResponse,
  ReconciliationOutput,
  ReconciliationResult,
  ReconciliationStatus,
  TextValues,
  WorkerResponse,
  WorkerRunRequest,
} from "./domain/types";
import { completionBanter, NIUMA_QUOTES, randomQuoteIndex } from "./lib/niuma-copy";

type Phase = "idle" | "running" | "done" | "error";
type ViewFilter = "all" | ReconciliationStatus | "issues";

const PAGE_SIZE = 50;
const AUTH_ENABLED = import.meta.env.VITE_AUTH_ENABLED === "true";
const APP_VERSION = `v${packageInfo.version}`;

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

function FileIcon({ multiple = false }: { multiple?: boolean }) {
  return (
    <Icon>
      {multiple && <path d="M8 3h8l4 4v10" />}
      <path d="M5 6h8l4 4v11H5V6Z" />
      <path d="M13 6v4h4M8 14h6M8 17h6" />
    </Icon>
  );
}

function ShieldIcon() {
  return (
    <Icon>
      <path d="M12 3 5 6v5c0 4.7 2.8 8.2 7 10 4.2-1.8 7-5.3 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-5" />
    </Icon>
  );
}

function PlayIcon() {
  return (
    <Icon>
      <path d="m9 7 8 5-8 5V7Z" />
    </Icon>
  );
}

function DownloadIcon() {
  return (
    <Icon>
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
    </Icon>
  );
}

function RefreshIcon() {
  return (
    <Icon>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6.1 8a7 7 0 0 1 11.7-2L20 8M4 16l2.2 2a7 7 0 0 0 11.7-2" />
    </Icon>
  );
}

function LogoutIcon() {
  return (
    <Icon>
      <path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
      <path d="m15 8 4 4-4 4M9 12h10" />
    </Icon>
  );
}

function SparkIcon() {
  return (
    <Icon>
      <path d="m12 3 1.1 3.4L16.5 8l-3.4 1.1L12 12.5l-1.1-3.4L7.5 8l3.4-1.6L12 3Z" />
      <path d="m18.5 13 .7 2.2 2.3.8-2.3.8-.7 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2ZM5 13l.7 1.8 1.8.7-1.8.7L5 18l-.7-1.8-1.8-.7 1.8-.7L5 13Z" />
    </Icon>
  );
}

function formatMoney(value: string): string {
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function textValues(values: TextValues): string[] {
  if (typeof values === "string") return values ? [values] : [];
  return values;
}

function join(values: TextValues, fallback = "—"): string {
  const items = textValues(values);
  return items.length > 0 ? items.join("；") : fallback;
}

function statusLabel(status: ReconciliationStatus): string {
  switch (status) {
    case "matched":
      return "一致";
    case "different":
      return "有差异";
    case "sc-only":
      return "仅速创";
    case "hrally-only":
      return "仅聚合力";
  }
}

interface FilePickerProps {
  title: string;
  hint: string;
  files: File[];
  multiple?: boolean;
  onChange: (files: File[]) => void;
  tone: "green" | "blue";
}

function FilePicker({ title, hint, files, multiple, onChange, tone }: FilePickerProps) {
  return (
    <label className={`file-picker file-picker-${tone} ${files.length > 0 ? "has-files" : ""}`}>
      <input
        type="file"
        accept=".xls,.xlsx"
        multiple={multiple}
        onChange={(event) => {
          onChange([...event.currentTarget.files ?? []]);
          event.currentTarget.value = "";
        }}
      />
      <span className="file-picker-icon"><FileIcon multiple={multiple} /></span>
      <span className="file-picker-copy">
        <strong>{files.length > 0 ? files.map((file) => file.name).join("、") : title}</strong>
        <small>{files.length > 0 ? `${files.length} 个文件已就绪` : hint}</small>
      </span>
      <span className="file-picker-action">{files.length > 0 ? "更换" : "+"}</span>
    </label>
  );
}

function ResultTable({ results }: { results: ReconciliationResult[] }) {
  return (
    <div className="table-scroll">
      <table className="results-table">
        <thead>
          <tr>
            <th>核对状态</th>
            <th>财务年月</th>
            <th>业务年月</th>
            <th>姓名 / 身份证号</th>
            <th>社保差额</th>
            <th>公积金差额</th>
            <th>服务费差额</th>
            <th>总金额差额</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => (
            <tr key={result.key}>
              <td><span className={`status status-${result.status}`}>{statusLabel(result.status)}</span></td>
              <td>{result.accYm}</td>
              <td>{result.realAccYm}</td>
              <td className="identity-cell">
                <strong>{join(result.scNames.length > 0 ? result.scNames : result.hrallyNames)}</strong>
                <small>{result.id}</small>
                {(result.scRowCount > 1 || result.hrallyRowCount > 1) && (
                  <em>已汇总：速创 {result.scRowCount} 条，聚合力 {result.hrallyRowCount} 条</em>
                )}
              </td>
              {[result.social, result.fund, result.service, result.total].map((item, index) => (
                <td key={index} className={item.difference !== "0.00" ? "money-different" : ""}>
                  {formatMoney(item.difference)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {results.length === 0 && <div className="empty-row">没有符合当前筛选条件的结果</div>}
    </div>
  );
}

function IssueTable({ issues }: { issues: ImportIssue[] }) {
  return (
    <div className="table-scroll">
      <table className="results-table issue-table">
        <thead><tr><th>来源</th><th>文件 / 工作表</th><th>Excel 行号</th><th>字段</th><th>问题</th><th>原始值</th></tr></thead>
        <tbody>
          {issues.map((issue, index) => (
            <tr key={`${issue.fileName}-${issue.sheetName}-${issue.rowNumber}-${issue.field}-${index}`}>
              <td>{issue.side === "sc" ? "速创" : issue.side === "hrally" ? "聚合力" : "客户清单"}</td>
              <td className="identity-cell"><strong>{issue.fileName}</strong><small>{issue.sheetName}</small></td>
              <td>{issue.rowNumber}</td>
              <td>{issue.field}</td>
              <td className="issue-message">{issue.message}</td>
              <td>{issue.rawValue || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {issues.length === 0 && <div className="empty-row">没有导入错误</div>}
    </div>
  );
}

export default function App() {
  const [scFiles, setScFiles] = useState<File[]>([]);
  const [hrallyFiles, setHrallyFiles] = useState<File[]>([]);
  const [customerFiles, setCustomerFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ stage: "", percent: 0 });
  const [error, setError] = useState("");
  const [output, setOutput] = useState<ReconciliationOutput | null>(null);
  const [filter, setFilter] = useState<ViewFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const exportWorkerRef = useRef<Worker | null>(null);
  const [quoteIndex, setQuoteIndex] = useState(() => randomQuoteIndex());

  useEffect(() => {
    if (phase !== "running") return;
    const timer = window.setInterval(() => {
      setQuoteIndex((current) => randomQuoteIndex(current));
    }, 2800);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => () => exportWorkerRef.current?.terminate(), []);

  const filteredResults = useMemo(() => {
    if (!output || filter === "issues") return [];
    const query = search.trim().toLocaleLowerCase("zh-CN");
    return output.results.filter((result) => {
      if (filter !== "all" && result.status !== filter) return false;
      if (!query) return true;
      const haystack = [
        result.id,
        ...textValues(result.scNames),
        ...textValues(result.hrallyNames),
        ...textValues(result.scCompanyNos),
        ...textValues(result.scCompanyNames),
        ...textValues(result.hrallyCompanyNames),
      ].join(" ").toLocaleLowerCase("zh-CN");
      return haystack.includes(query);
    });
  }, [filter, output, search]);

  const totalPages = Math.max(1, Math.ceil(filteredResults.length / PAGE_SIZE));
  const visibleResults = filteredResults.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function changeFilter(next: ViewFilter) {
    setFilter(next);
    setPage(1);
  }

  async function runReconciliation() {
    if (scFiles.length !== 1 || hrallyFiles.length === 0) return;
    setPhase("running");
    setOutput(null);
    setError("");
    setProgress({ stage: "正在准备文件", percent: 4 });
    setQuoteIndex((current) => randomQuoteIndex(current));

    try {
      const worker = new Worker(new URL("./workers/reconcile.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.type === "progress") {
          setProgress({ stage: message.stage, percent: message.percent });
          return;
        }
        if (message.type === "complete") {
          setOutput(message.output);
          setPhase("done");
          setProgress({ stage: "核对完成", percent: 100 });
          setFilter("all");
          setSearch("");
          setPage(1);
          worker.terminate();
          return;
        }
        setError(message.message);
        setPhase("error");
        worker.terminate();
      };
      worker.onerror = () => {
        setError("核对线程发生异常，请重新选择文件后再试。");
        setPhase("error");
        worker.terminate();
      };
      const request: WorkerRunRequest = {
        type: "run",
        scFile: scFiles[0],
        hrallyFiles,
        customerFile: customerFiles[0],
      };
      worker.postMessage(request);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取文件失败，请重新选择。");
      setPhase("error");
    }
  }

  function reset() {
    exportWorkerRef.current?.terminate();
    exportWorkerRef.current = null;
    setPhase("idle");
    setOutput(null);
    setError("");
    setProgress({ stage: "", percent: 0 });
    setFilter("all");
    setSearch("");
    setPage(1);
    setExporting(false);
    setExportError("");
  }

  async function handleExport() {
    if (!output || exporting) return;
    setExporting(true);
    setExportError("");

    // Let React paint the busy state before copying a potentially large result to the worker.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL("./workers/export.worker.ts", import.meta.url), {
        type: "module",
      });
      exportWorkerRef.current = worker;

      const result = await new Promise<Extract<ExportWorkerResponse, { type: "complete" }>>(
        (resolve, reject) => {
          if (!worker) {
            reject(new Error("无法启动 Excel 导出线程。"));
            return;
          }
          worker.onmessage = (event: MessageEvent<ExportWorkerResponse>) => {
            if (event.data.type === "complete") {
              resolve(event.data);
              return;
            }
            reject(new Error(event.data.message));
          };
          worker.onerror = (event) => {
            reject(new Error(event.message || "Excel 导出线程发生异常。"));
          };
          const request: ExportWorkerRequest = { type: "export", output };
          worker.postMessage(request);
        },
      );

      const url = URL.createObjectURL(new Blob(
        [result.data],
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      ));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : "Excel 生成失败，请重新尝试。");
    } finally {
      worker?.terminate();
      if (exportWorkerRef.current === worker) exportWorkerRef.current = null;
      setExporting(false);
    }
  }

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      const response = await fetch("/api/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("logout failed");
      window.location.replace("/login.html?loggedOut=1");
    } catch {
      window.alert("退出登录失败，请稍后重试。");
      setLoggingOut(false);
    }
  }

  const canRun = scFiles.length === 1 && hrallyFiles.length > 0 && phase !== "running";

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-logo"><img src={niumaLogo} alt="" /></span>
          <span><strong>牛马对账</strong><small>速创 · 聚合力账单核对</small></span>
        </div>
        <div className="header-actions">
          <span className="privacy-note"><ShieldIcon />文件仅在本机浏览器中处理</span>
          {AUTH_ENABLED && (
            <button className="logout-button" type="button" disabled={loggingOut} onClick={handleLogout}>
              <LogoutIcon />{loggingOut ? "正在退出" : "退出登录"}
            </button>
          )}
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-layout">
            <img className="hero-logo" src={niumaLogo} alt="牛马对账" />
            <div className="hero-copy">
              <span className="hero-kicker">账单核对工具</span>
              <h1>放入两套账单，立即开始核对</h1>
              <p>按照财务年月、业务年月和身份证号自动汇总，金额精确到分。</p>
            </div>
          </div>
        </section>

        <section className="file-section" aria-label="选择账单文件">
          <div className="file-grid">
            <FilePicker title="选择速创账单" hint="支持 .xls 或 .xlsx" files={scFiles} onChange={(files) => { setScFiles(files.slice(0, 1)); reset(); }} tone="green" />
            <span className="file-plus">+</span>
            <FilePicker title="选择聚合力账单" hint="支持一次选择多个文件" files={hrallyFiles} multiple onChange={(files) => { setHrallyFiles(files); reset(); }} tone="blue" />
          </div>

          <details className="customer-option">
            <summary>＋ 添加可选的客户清单</summary>
            <div>
              <FilePicker title="选择客户清单" hint="用于补充客户组和发包方名称" files={customerFiles} onChange={(files) => { setCustomerFiles(files.slice(0, 1)); reset(); }} tone="green" />
            </div>
          </details>

          <button className="run-button" type="button" disabled={!canRun} onClick={runReconciliation}>
            {phase === "running" ? <span className="spinner" /> : <PlayIcon />}
            {phase === "running" ? progress.stage : "开始核对"}
          </button>

          {phase === "running" && (
            <>
              <div className="progress-wrap" aria-live="polite">
                <span><i style={{ width: `${progress.percent}%` }} /></span>
                <small>{progress.percent}%</small>
              </div>
              <aside className="niuma-broadcast" aria-label="今日牛马情绪播报">
                <span className="niuma-broadcast-logo"><img src={niumaLogo} alt="" /></span>
                <div className="niuma-broadcast-copy">
                  <span className="niuma-broadcast-title"><SparkIcon />今日牛马情绪播报 <em>自动滚动中</em></span>
                  <blockquote key={quoteIndex}>「{NIUMA_QUOTES[quoteIndex]}」</blockquote>
                </div>
                <button type="button" onClick={() => setQuoteIndex((current) => randomQuoteIndex(current))}>再 Roll 一条</button>
              </aside>
            </>
          )}
          {phase === "error" && <div className="error-banner" role="alert">{error}</div>}
        </section>

        {output && phase === "done" ? (
          <section className="result-section" aria-label="核对结果">
            <div className="result-heading">
              <div className="result-heading-copy">
                <h2>核对完成</h2>
                <p>共生成 {output.summary.total.toLocaleString("zh-CN")} 条三键汇总结果</p>
                <div className="completion-banter"><SparkIcon /><span>{completionBanter(output.summary)}</span></div>
              </div>
              <div className="result-actions">
                <button type="button" className="secondary-button" onClick={reset}><RefreshIcon />重新核对</button>
                <button type="button" className="primary-button" disabled={exporting} onClick={handleExport}>
                  {exporting ? <span className="spinner" /> : <DownloadIcon />}
                  {exporting ? "正在生成 Excel" : "导出 Excel"}
                </button>
              </div>
            </div>

            {!output.detailsIncluded && !exporting && (
              <div className="large-mode-note">
                已使用大文件模式逐行汇总；导出文件不包含两套原始明细，但仍会完整保留 Excel 样式。生成大文件时耗时较长，请勿关闭页面。
              </div>
            )}

            {exporting && (
              <div className="export-status" role="status" aria-live="polite">
                <span className="export-status-spinner" />
                {output.detailsIncluded
                  ? "正在后台生成并美化 Excel，页面仍可正常操作，请勿关闭。"
                  : "正在后台生成并美化 Excel；当前为大文件模式，导出不包含两套原始明细，但会完整保留 Excel 样式。生成可能需要几分钟，请勿关闭页面。"}
              </div>
            )}
            {exportError && <div className="export-error" role="alert">导出失败：{exportError}</div>}

            <div className="summary-grid">
              {[
                ["all", "全部结果", output.summary.total],
                ["matched", "金额一致", output.summary.matched],
                ["different", "存在差异", output.summary.different],
                ["sc-only", "仅速创", output.summary.scOnly],
                ["hrally-only", "仅聚合力", output.summary.hrallyOnly],
                ["issues", "导入错误", output.summary.importIssues],
              ].map(([value, label, count]) => (
                <button key={String(value)} type="button" className={filter === value ? "is-active" : ""} onClick={() => changeFilter(value as ViewFilter)}>
                  <span>{label}</span><strong>{Number(count).toLocaleString("zh-CN")}</strong>
                </button>
              ))}
            </div>

            {filter !== "issues" && (
              <div className="result-toolbar">
                <input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索姓名、身份证号或客户" aria-label="搜索核对结果" />
                <span>当前显示 {filteredResults.length.toLocaleString("zh-CN")} 条</span>
              </div>
            )}

            {filter === "issues" ? <IssueTable issues={output.issues} /> : <ResultTable results={visibleResults} />}

            {filter !== "issues" && totalPages > 1 && (
              <nav className="pagination" aria-label="结果分页">
                <button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
                <span>第 {page} / {totalPages} 页</span>
                <button type="button" disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
              </nav>
            )}

            <div className="source-summary">
              {output.selectedSheets.map((sheet) => (
                <span key={`${sheet.side}-${sheet.fileName}-${sheet.sheetName}`}>
                  <strong>{sheet.side === "sc" ? "速创" : sheet.side === "hrally" ? "聚合力" : "客户清单"}</strong>
                  {sheet.fileName} · {sheet.sheetName} · {sheet.recordCount.toLocaleString("zh-CN")} 条
                </span>
              ))}
            </div>
          </section>
        ) : (
          <section className="result-placeholder" aria-label="结果预览">
            <div><strong>核对结果会显示在这里</strong><small>完成后可以筛选差异并导出 Excel</small></div>
            <span><ShieldIcon />原始账单不会上传或保存</span>
            <i /><i /><i />
          </section>
        )}
      </main>

      <footer>
        <span>牛马对账 · 纯浏览器核对 · 无数据库 · 无服务端上传</span>
        <span className="version-badge" aria-label={`当前版本 ${APP_VERSION}`}>{APP_VERSION}</span>
      </footer>
    </div>
  );
}
