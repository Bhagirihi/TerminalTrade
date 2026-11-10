import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Clock,
  Landmark,
  Scale,
  Wallet,
  Zap,
} from "lucide-react";
import { book } from "./data.js";

const inr = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function money(n, signed = false) {
  const body = `₹${inr.format(Math.abs(n))}`;
  if (!signed) return n < 0 ? `−${body}` : body;
  if (n > 0) return `+${body}`;
  if (n < 0) return `−${body}`;
  return body;
}

function percent(n) {
  const body = `${Math.abs(n).toFixed(2)}%`;
  if (n > 0) return `+${body}`;
  if (n < 0) return `−${body}`;
  return body;
}

function useIstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(now) + " IST"
  );
}

function PnL({ value, kind = "money" }) {
  const up = value > 0;
  const down = value < 0;
  const cls = up ? "text-emerald-400" : down ? "text-rose-400" : "text-slate-200";
  return <span className={`tabular ${cls}`}>{kind === "pct" ? percent(value) : money(value, true)}</span>;
}

function Kpi({ icon: Icon, label, value, hint, tone }) {
  const valueCls =
    tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-slate-50";
  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Icon size={14} strokeWidth={1.75} />
        <span>{label}</span>
      </div>
      <p className={`mt-3 text-xl font-medium tracking-tight tabular sm:text-2xl ${valueCls}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </article>
  );
}

const TABS = [
  { id: "sell", label: "Review a reduction", icon: ArrowDownRight },
  { id: "keep", label: "Keep & performers", icon: ArrowUpRight },
  { id: "intra", label: "Intraday list", icon: Zap },
  { id: "chart", label: "P&L chart", icon: BarChart3 },
];

function SortHeader({ label, k, sort, onSort, align = "left" }) {
  const active = sort.key === k;
  return (
    <th className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 ${align === "right" ? "ml-auto" : ""} ${active ? "text-slate-100" : "text-slate-400"}`}
      >
        {label}
        <span className="text-[10px] text-slate-500">{active ? (sort.dir === "asc" ? "↑" : "↓") : ""}</span>
      </button>
    </th>
  );
}

function useSort(rows, initialKey, initialDir) {
  const [sort, setSort] = useState({ key: initialKey, dir: initialDir });
  const onSort = (key) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "ticker" ? "asc" : "desc" }
    );
  };
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort]);
  return { sorted, sort, onSort };
}

function DesktopTable({ rows, columns, sort, onSort }) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-slate-800 text-xs uppercase tracking-wide">
          <tr>
            {columns.map((col) => (
              <SortHeader key={col.key} label={col.label} k={col.key} sort={sort} onSort={onSort} align={col.align} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ticker} className="border-b border-slate-800/80 last:border-0">
              {columns.map((col) => (
                <td key={col.key} className={`px-3 py-3 ${col.align === "right" ? "text-right" : ""} ${col.muted ? "text-slate-400" : "text-slate-100"}`}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MobileCards({ rows, noteKey }) {
  return (
    <div className="space-y-3 md:hidden">
      {rows.map((row) => (
        <article key={row.ticker} className="rounded-xl border border-slate-800 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">{row.ticker}</p>
              <p className="mt-1 text-xs text-slate-400">
                {row.qty} shares · paid {inr.format(row.paid)} · now {inr.format(row.now)}
              </p>
            </div>
            <PnL value={row.pnlPercent} kind="pct" />
          </div>
          <p className="mt-3 text-lg">
            <PnL value={row.pnl} />
          </p>
          <p className="mt-2 text-sm text-slate-400">{row[noteKey]}</p>
        </article>
      ))}
    </div>
  );
}

function HoldingsPane({ rows, noteKey, noteLabel, initialKey, initialDir }) {
  const { sorted, sort, onSort } = useSort(rows, initialKey, initialDir);
  const columns = [
    { key: "ticker", label: "Scrip", render: (r) => r.ticker },
    { key: "qty", label: "Qty", align: "right", render: (r) => <span className="tabular">{r.qty}</span> },
    { key: "paid", label: "Avg", align: "right", muted: true, render: (r) => <span className="tabular">{inr.format(r.paid)}</span> },
    { key: "now", label: "Live", align: "right", render: (r) => <span className="tabular">{inr.format(r.now)}</span> },
    { key: "pnl", label: "P&L ₹", align: "right", render: (r) => <PnL value={r.pnl} /> },
    { key: "pnlPercent", label: "P&L %", align: "right", render: (r) => <PnL value={r.pnlPercent} kind="pct" /> },
    ...(noteKey === "status"
      ? [{ key: "rsi", label: "RSI", align: "right", muted: true, render: (r) => <span className="tabular">{r.rsi.toFixed(2)}</span> }]
      : []),
    { key: noteKey, label: noteLabel, muted: true, render: (r) => r[noteKey] },
  ];
  return (
    <div>
      <DesktopTable rows={sorted} columns={columns} sort={sort} onSort={onSort} />
      <MobileCards rows={sorted} noteKey={noteKey} />
    </div>
  );
}

function ChartTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs">
      <p className="font-medium text-slate-100">{row.ticker}</p>
      <p className="mt-1">
        <PnL value={row.pnl} />
      </p>
    </div>
  );
}

function Distribution() {
  const data = useMemo(() => {
    const rows = [
      ...book.sellCandidates.map((r) => ({ ticker: r.ticker, pnl: r.pnl })),
      ...book.keepHoldings.map((r) => ({ ticker: r.ticker, pnl: r.pnl })),
    ].sort((a, b) => a.pnl - b.pnl);
    return rows;
  }, []);
  const lossWidth = (Math.abs(book.summary.totalLoss) / (Math.abs(book.summary.totalLoss) + book.summary.totalProfit)) * 100;
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-300">Gains against losses, full book</p>
        <p className="mt-1 text-xs text-slate-500">Unrealized rupees. Gains {money(book.summary.totalProfit, true)} · losses {money(book.summary.totalLoss, true)}</p>
        <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-800">
          <div className="bg-rose-500" style={{ width: `${lossWidth}%` }} />
          <div className="bg-emerald-500" style={{ width: `${100 - lossWidth}%` }} />
        </div>
        <div className="mt-2 flex justify-between text-xs text-slate-400">
          <span>Losses {lossWidth.toFixed(0)}%</span>
          <span>Gains {(100 - lossWidth).toFixed(0)}%</span>
        </div>
      </div>
      <div className="h-[520px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
            <CartesianGrid stroke="#1e293b" horizontal={false} />
            <XAxis type="number" stroke="#64748b" tick={{ fill: "#94a3b8", fontSize: 11 }} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
            <YAxis type="category" dataKey="ticker" width={84} stroke="#64748b" tick={{ fill: "#cbd5e1", fontSize: 11 }} />
            <Tooltip content={<ChartTip />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
            <Bar dataKey="pnl" radius={[0, 4, 4, 0]} barSize={14}>
              {data.map((row) => (
                <Cell key={row.ticker} fill={row.pnl >= 0 ? "#10b981" : "#f43f5e"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-slate-500">Unrealized P&L (₹) for the names in the two tables. Sorted from the largest loss to the largest gain.</p>
    </div>
  );
}

export default function App() {
  const clock = useIstClock();
  const [tab, setTab] = useState("sell");
  const { summary } = book;
  const shortfall = Math.abs(summary.netPnL);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Upstox delivery book</p>
            <h1 className="mt-1 text-2xl font-medium tracking-tight">Portfolio</h1>
            <p className="mt-2 flex items-center gap-2 text-sm text-slate-400">
              <Clock size={14} />
              <span className="tabular">{clock}</span>
              <span className="text-slate-600">·</span>
              <span>Prices from 25 Oct 2026</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-3 py-1 text-sm text-rose-300">
              Net {percent(summary.netPnLPercent)}
            </span>
            <span className="rounded-full border border-slate-700 px-3 py-1 text-sm text-slate-300">{book.sellCandidates.length} to review</span>
            <span className="rounded-full border border-slate-700 px-3 py-1 text-sm text-slate-300">{book.keepHoldings.length} in the second list</span>
          </div>
        </header>

        <section className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi icon={Wallet} label="Capital invested" value={money(summary.totalInvested)} />
          <Kpi icon={Landmark} label="Current value" value={money(summary.currentValue)} />
          <Kpi
            icon={Scale}
            label="Net unrealized P&L"
            value={money(summary.netPnL, true)}
            hint={percent(summary.netPnLPercent)}
            tone="down"
          />
          <Kpi icon={AlertTriangle} label="Shortfall to breakeven" value={money(shortfall)} hint="Unrealized. Not a buy target." tone="down" />
        </section>

        <p className="mt-4 text-xs leading-5 text-slate-500">
          KPI totals are the full 26-name book. These tables leave out INOXINDIA, BEL, VAML, and NSE, so the rows sum to about ₹11,422 less than the net figure. Labels are not orders.
        </p>

        <div className="mt-6 flex gap-2 overflow-x-auto pb-1">
          {TABS.map((item) => {
            const Icon = item.icon;
            const on = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                  on ? "border-slate-600 bg-slate-800 text-slate-50" : "border-slate-800 text-slate-400"
                }`}
              >
                <Icon size={15} strokeWidth={1.75} />
                {item.label}
              </button>
            );
          })}
        </div>

        <section className="mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-3 sm:p-4">
          {tab === "sell" ? (
            <HoldingsPane rows={book.sellCandidates} noteKey="status" noteLabel="Signal" initialKey="pnl" initialDir="asc" />
          ) : null}
          {tab === "keep" ? (
            <HoldingsPane rows={book.keepHoldings} noteKey="note" noteLabel="Note" initialKey="pnl" initialDir="desc" />
          ) : null}
          {tab === "intra" ? (
            <div className="space-y-3">
              <p className="text-sm text-slate-400">
                These four names are a supplied watchlist. The strategy and risk/reward text is not a live level, and it is not a profit target.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {book.intradayAlternatives.map((item) => (
                  <article key={item.instrument} className="rounded-xl border border-slate-800 p-4">
                    <h2 className="text-base font-medium">{item.instrument}</h2>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex justify-between gap-4">
                        <dt className="text-slate-500">Approach</dt>
                        <dd className="text-right text-slate-200">{item.strategy}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-slate-500">Window</dt>
                        <dd className="text-right text-slate-200">{item.timeframe}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-slate-500">Stated risk/reward</dt>
                        <dd className="text-right text-slate-200">{item.riskReward}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-slate-500">Liquidity note</dt>
                        <dd className="text-right text-slate-200">{item.volume}</dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
          {tab === "chart" ? <Distribution /> : null}
        </section>
      </div>
    </div>
  );
}
