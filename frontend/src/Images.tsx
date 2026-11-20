import { useEffect, useMemo, useState } from "react";
import { call, on, type Image, type PullState, type Run } from "./bridge";
import { ago, bytes, shortId } from "./format";
import { Dialog, IconButton, Progress } from "./ui";

interface Props {
  images: Image[];
  run: Run;
  onRun: (image: string) => void;
}

const title = (im: Image) => im.tags[0] ?? "이름 없음";

export default function Images({ images, run, onRun }: Props) {
  const [query, setQuery] = useState("");
  const [ref, setRef] = useState("");
  const [pull, setPull] = useState<PullState | null>(null);
  const [removing, setRemoving] = useState<Image | null>(null);
  const [tagging, setTagging] = useState<{ im: Image; draft: string } | null>(null);
  const [pruning, setPruning] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => on("pull", (p: PullState) => setPull(p.done ? null : p)), []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return images
      .filter((im) => !q || im.tags.some((t) => t.toLowerCase().includes(q)) || im.id.includes(q))
      .sort((a, b) => title(a).localeCompare(title(b)));
  }, [images, query]);

  const dangling = images.filter((im) => im.tags.length === 0 && im.inUse === 0);
  const total = images.reduce((n, im) => n + im.size, 0);

  const startPull = async () => {
    const name = ref.trim();
    if (!name || pull) return;
    setNote("");
    setPull({ ref: name, status: "", percent: -1, done: false, error: "" });
    if (await run(`docker pull ${name}`, () => call("PullImage", name))) {
      setRef("");
      setNote(`${name} 이미지를 받았습니다.`);
    }
    setPull(null);
  };

  const confirmRemove = async () => {
    if (!removing) return;
    const im = removing;
    setRemoving(null);
    // One tag: remove by name, as `docker rmi name` does. Otherwise by ID,
    // which needs force when several tags (or a container) hold the image.
    const single = im.tags.length === 1 && im.inUse === 0;
    const target = single ? im.tags[0] : shortId(im.id);
    await run(`docker rmi${single ? "" : " -f"} ${target}`, () => call("RemoveImage", single ? im.tags[0] : im.id, !single));
  };

  const confirmTag = async () => {
    if (!tagging) return;
    const { im, draft } = tagging;
    const target = draft.trim();
    setTagging(null);
    if (!target) return;
    const source = im.tags[0] ?? shortId(im.id);
    await run(`docker tag ${source} ${target}`, () => call("TagImage", im.tags[0] ?? im.id, target));
  };

  const confirmPrune = async () => {
    setPruning(false);
    let freed = 0;
    if (await run("docker image prune -f", async () => (freed = await call<number>("PruneImages")))) {
      setNote(`이름 없는 이미지를 정리해 ${bytes(freed)}를 확보했습니다.`);
    }
  };

  return (
    <section>
      <header className="page-head">
        <h1>이미지</h1>
        <span className="muted">
          {images.length}개 · {bytes(total)}
        </span>
        <input className="search" type="search" placeholder="이름·ID 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        {dangling.length > 0 && <button onClick={() => setPruning(true)}>이름 없는 이미지 정리</button>}
      </header>

      <form
        className="pull-bar"
        onSubmit={(e) => {
          e.preventDefault();
          startPull();
        }}
      >
        <label htmlFor="pull-ref">이미지 받기</label>
        <input
          id="pull-ref"
          placeholder="예: nginx, postgres:17, ghcr.io/owner/app:1.0"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          disabled={!!pull}
        />
        <button className="primary" type="submit" disabled={!ref.trim() || !!pull}>
          받기
        </button>
      </form>
      {pull && (
        <div className="pull-progress" data-testid="pull-progress">
          <span>
            {pull.ref} 받는 중{pull.percent >= 0 ? ` · ${pull.percent}%` : ""} <span className="muted">{pull.status}</span>
          </span>
          <Progress percent={pull.percent} />
        </div>
      )}
      {note && !pull && <p className="note">{note}</p>}

      {shown.length === 0 ? (
        <p className="empty">{images.length === 0 ? "이미지가 없습니다. 위에서 이름을 넣어 받아 보세요." : "조건에 맞는 이미지가 없습니다."}</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>이름</th>
              <th>ID</th>
              <th className="num">크기</th>
              <th>만든 때</th>
              <th>사용</th>
              <th className="actions">작업</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((im) => (
              <tr key={im.id} data-testid={`image-${title(im)}`}>
                <td className="name-cell">
                  <span className={"name" + (im.tags.length ? "" : " muted")}>{title(im)}</span>
                  {im.tags.slice(1).map((t) => (
                    <span key={t} className="sub">
                      {t}
                    </span>
                  ))}
                </td>
                <td>
                  <code className="muted">{shortId(im.id)}</code>
                </td>
                <td className="num nowrap">{bytes(im.size)}</td>
                <td className="muted nowrap">{ago(im.created)}</td>
                <td className="nowrap">{im.inUse > 0 ? `컨테이너 ${im.inUse}개` : <span className="muted">—</span>}</td>
                <td className="actions">
                  {im.tags.length > 0 && (
                    <IconButton icon="play" label="이 이미지로 컨테이너 실행" tone="go" onClick={() => onRun(im.tags[0])} />
                  )}
                  <IconButton icon="tag" label="태그 추가" onClick={() => setTagging({ im, draft: "" })} />
                  <IconButton icon="trash" label="삭제" tone="danger" onClick={() => setRemoving(im)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {removing && (
        <Dialog title="이미지 삭제" onClose={() => setRemoving(null)}>
          <p>
            <strong>{title(removing)}</strong> 이미지를 삭제합니다. 다시 쓰려면 새로 받아야 합니다.
          </p>
          {removing.tags.length > 1 && <p className="warn">이 이미지의 태그 {removing.tags.length}개가 모두 삭제됩니다.</p>}
          {removing.inUse > 0 && (
            <p className="warn">컨테이너 {removing.inUse}개가 이 이미지로 만들어졌습니다. 강제로 삭제하며, 그 컨테이너들은 남습니다.</p>
          )}
          <div className="dialog-actions">
            <button onClick={() => setRemoving(null)}>취소</button>
            <button className="danger solid" onClick={confirmRemove}>
              삭제
            </button>
          </div>
        </Dialog>
      )}

      {tagging && (
        <Dialog title="태그 추가" onClose={() => setTagging(null)}>
          <p>
            <strong>{title(tagging.im)}</strong> 이미지에 이름을 하나 더 붙입니다. 이미지가 복사되지는 않습니다.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirmTag();
            }}
          >
            <input
              autoFocus
              className="field"
              aria-label="새 태그"
              placeholder="예: myapp:1.0"
              value={tagging.draft}
              onChange={(e) => setTagging({ ...tagging, draft: e.target.value })}
            />
            <div className="dialog-actions">
              <button type="button" onClick={() => setTagging(null)}>
                취소
              </button>
              <button className="primary" type="submit" disabled={!tagging.draft.trim()}>
                추가
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {pruning && (
        <Dialog title="이름 없는 이미지 정리" onClose={() => setPruning(false)}>
          <p>
            이름이 없고 어떤 컨테이너도 쓰지 않는 이미지 {dangling.length}개를 삭제합니다. 약{" "}
            {bytes(dangling.reduce((n, im) => n + im.size, 0))}입니다. 보통 이미지를 다시 빌드하거나 새로 받으면서 남은
            예전 버전입니다.
          </p>
          <div className="dialog-actions">
            <button onClick={() => setPruning(false)}>취소</button>
            <button className="danger solid" onClick={confirmPrune}>
              정리
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
