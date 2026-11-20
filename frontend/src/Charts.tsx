import { useEffect, useState } from "react";
import { call, on } from "./bridge";
import { bytes } from "./format";

interface Sample {
  cpu: number;
  memUsed: number;
  memLimit: number;
  netRx: number;
  netTx: number;
}

// How many samples a chart keeps: one a second, so this many seconds.
const span = 60;
const W = 280;
const H = 56;

/** One measure over the last minute: its newest value as text, the line, and a readout under the pointer. */
function Spark(props: { title: string; values: number[]; top: number; format: (v: number) => string }) {
  const { values, top } = props;
  const [at, setAt] = useState<number | null>(null);
  const n = values.length;
  // The newest sample sits at the right edge; older ones run left, a second apart.
  const x = (i: number) => W - (n - 1 - i) * (W / (span - 1));
  const y = (v: number) => H - 2 - (Math.min(v, top) / top) * (H - 6);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const hover = at !== null && at < n ? at : null;
  const shown = hover ?? n - 1;
  return (
    <div className="spark">
      <div className="spark-head">
        <span className="muted">{props.title}</span>
        <strong>{n ? props.format(values[shown]) : "—"}</strong>
        <span className="muted">{hover !== null && n - 1 - hover > 0 ? `${n - 1 - hover}초 전` : "지금"}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${props.title}: 최근 1분, 지금 ${n ? props.format(values[n - 1]) : "측정 전"}`}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          const i = Math.round(n - 1 - (W - px) / (W / (span - 1)));
          setAt(i >= 0 && i < n ? i : null);
        }}
        onMouseLeave={() => setAt(null)}
      >
        <line className="spark-base" x1="0" x2={W} y1={H - 2} y2={H - 2} />
        {n > 1 && <path className="spark-line" d={line} />}
        {hover !== null && <line className="spark-cross" x1={x(hover)} x2={x(hover)} y1="0" y2={H} />}
        {n > 0 && <circle className="spark-dot" cx={x(shown)} cy={y(values[shown])} r="3" />}
      </svg>
      <div className="spark-scale muted">
        <span>1분 전</span>
        <span>최대 눈금 {props.format(top)}</span>
      </div>
    </div>
  );
}

/** A round number at or above v, for a chart's top. */
function ceil(v: number, steps: number[]) {
  return steps.find((s) => s >= v) ?? Math.ceil(v / steps[steps.length - 1]) * steps[steps.length - 1];
}

/** Live CPU and memory of one running container. */
export default function Charts({ id }: { id: string }) {
  const [samples, setSamples] = useState<Sample[]>([]);

  useEffect(() => {
    setSamples([]);
    const off = on("stats", (s: Sample & { id: string }) => {
      if (s.id === id) setSamples((old) => old.concat(s).slice(-span));
    });
    call("StartStats", id).catch(() => {});
    return () => {
      off();
      call("StopStats", id).catch(() => {});
    };
  }, [id]);

  const last = samples[samples.length - 1];
  const cpu = samples.map((s) => s.cpu);
  const mem = samples.map((s) => s.memUsed);
  const mib = 2 ** 20;
  const memTop = ceil(Math.max(...mem, 1), [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384].map((m) => m * mib));
  return (
    <div className="charts" data-testid="charts">
      <Spark title="CPU" values={cpu} top={ceil(Math.max(...cpu, 1), [10, 25, 50, 100, 200, 400, 800])} format={(v) => `${v.toFixed(1)}%`} />
      <Spark title="메모리" values={mem} top={memTop} format={bytes} />
      {last && (
        <p className="muted charts-note">
          메모리 한도 {bytes(last.memLimit)} · 네트워크 받음 {bytes(last.netRx)}, 보냄 {bytes(last.netTx)} · CPU 100%는 코어 하나를 다 쓰는
          것입니다.
        </p>
      )}
    </div>
  );
}
