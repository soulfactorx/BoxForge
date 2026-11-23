// A Compose project, moved to Kubernetes: what it becomes, what doesn't
// carry over, which of the engine's images go into the cluster, and the
// YAML, to read or change before it is applied.
import { useEffect, useState } from "react";
import { call } from "./bridge";
import type { KubeMove } from "./Kubernetes";
import { Dialog } from "./ui";

interface KubeVolume {
  volume: string;
  claim: string;
  deployments: string[];
}

interface KubePlan {
  volumes: KubeVolume[];
  namespace: string;
  yaml: string;
  deployments: string[];
  built: string[];
  images: string[];
  notes: string[];
}

export default function ComposeKube(props: { project: string; files: string[]; showCli: (cmd: string) => void; onMove: (m: KubeMove) => void; onClose: () => void }) {
  const [plan, setPlan] = useState<KubePlan | null>(null);
  const [error, setError] = useState("");
  const [yaml, setYaml] = useState("");
  const [showYaml, setShowYaml] = useState(false);
  // The project's images the engine has, and which go into the cluster.
  const [here, setHere] = useState<string[]>([]);
  const [load, setLoad] = useState<string[]>([]);
  // The volumes whose data is copied over, by claim.
  const [copy, setCopy] = useState<string[]>([]);

  useEffect(() => {
    props.showCli(`docker compose -p ${props.project} config  # 를 Kubernetes 매니페스트로 (Deployment · Service · PVC)`);
    call<KubePlan>("ComposeToKube", props.project, props.files).then(
      async (p) => {
        setPlan(p);
        setYaml(p.yaml);
        setCopy(p.volumes.map((v) => v.claim));
        const have: string[] = [];
        for (const image of p.images) {
          if (await call("ImageDefaults", image).then(() => true, () => false)) have.push(image);
        }
        setHere(have);
        // All the engine has, by default: the project runs them here now,
        // and some may exist nowhere else (built, or tagged on this PC).
        // Big ones can be left to the cluster to fetch.
        setLoad(have);
      },
      (e) => setError(e.message),
    );
  }, []);

  const missing = plan ? plan.built.filter((b) => !here.includes(b)) : [];
  return (
    <Dialog title={`${props.project} 를 Kubernetes로 옮기기`} onClose={props.onClose} wide>
      {!plan && !error && (
        <p role="status">
          <span className="spinner" /> Compose 파일을 읽는 중…
        </p>
      )}
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      {plan && (
        <div className="run-form" data-testid="compose-kube">
          <p>{`Kubernetes 클러스터의 네임스페이스 ${plan.namespace}에 서비스 ${plan.deployments.length}개(${plan.deployments.join(", ")})를 배포합니다. 같은 네임스페이스라서 서비스끼리는 Compose에서처럼 이름으로 서로 찾습니다. Compose로 띄운 컨테이너는 그대로 둡니다.`}</p>
          {plan.notes.length > 0 && (
            <div className="note-box" data-testid="compose-kube-notes">
              <strong>옮기면서 달라지는 것</strong>
              <ul className="plain-list">
                {plan.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          {here.length > 0 && (
            <fieldset>
              <legend>클러스터에 넣을 이 PC(엔진)의 이미지</legend>
              <p className="help">지금 이 PC에서 돌고 있는 이미지를 그대로 클러스터에 넣습니다. 이 PC에서 만든 이미지는 넣어야 쓸 수 있습니다. Docker Hub 등에서 받을 수 있는 큰 이미지는 꺼서 클러스터가 직접 받게 해도 됩니다.</p>
              {here.map((image) => (
                <label key={image} className="check">
                  <input type="checkbox" checked={load.includes(image)} onChange={(e) => setLoad(e.target.checked ? [...load, image] : load.filter((x) => x !== image))} />
                  <code>{image}</code>
                  {plan.built.includes(image) && <span className="muted">{" · 이 PC에서 빌드한 이미지"}</span>}
                </label>
              ))}
            </fieldset>
          )}
          {plan.volumes.length > 0 && (
            <fieldset>
              <legend>클러스터로 옮길 볼륨의 데이터</legend>
              <p className="help">배포한 뒤, 볼륨의 지금 데이터를 새 저장소에 그대로 복사합니다. 복사하는 동안 그 저장소를 쓰는 앱은 잠깐 0개로 줄었다가 다시 켜집니다. 끄면 빈 저장소로 시작합니다.</p>
              {plan.volumes.map((v) => (
                <label key={v.claim} className="check">
                  <input type="checkbox" checked={copy.includes(v.claim)} onChange={(e) => setCopy(e.target.checked ? [...copy, v.claim] : copy.filter((x) => x !== v.claim))} />
                  <span>{`${v.volume} → 저장소 ${v.claim} (${v.deployments.join(", ")})`}</span>
                </label>
              ))}
            </fieldset>
          )}
          {missing.length > 0 && (
            <p className="warn" role="alert">
              {`빌드한 이미지(${missing.join(", ")})가 이 PC(엔진)에 없습니다. 먼저 Compose로 올려서(빌드) 만든 뒤 옮기세요.`}
            </p>
          )}
          <button type="button" className="link" onClick={() => setShowYaml(!showYaml)}>
            {showYaml ? "YAML 숨기기" : "만들어질 YAML 보기 · 고치기"}
          </button>
          {showYaml && <textarea className="editor" aria-label="옮길 YAML" spellCheck={false} value={yaml} onChange={(e) => setYaml(e.target.value)} />}
          <div className="dialog-actions">
            <button type="button" onClick={props.onClose}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              disabled={!yaml.trim() || missing.length > 0}
              onClick={() => props.onMove({ namespace: plan.namespace, yaml, load, deployments: plan.deployments, copy: plan.volumes.filter((v) => copy.includes(v.claim)) })}
            >
              Kubernetes에 배포
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
