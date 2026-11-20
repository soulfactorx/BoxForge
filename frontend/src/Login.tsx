import { useState } from "react";

/** The sign-in page of the web server: one password. */
export default function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", { method: "POST", body: JSON.stringify({ password }) });
      const body = await res.json();
      if (body.auth) {
        onDone();
        return;
      }
      setError(res.status === 429 ? `비밀번호를 여러 번 틀렸습니다. ${body.wait ?? 60}초 뒤에 다시 시도하세요.` : "비밀번호가 맞지 않습니다.");
    } catch {
      setError("서버에 연결하지 못했습니다.");
    }
    setBusy(false);
  };

  return (
    <main className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="brand">
          <img src="./icon.svg" alt="" />
          <span>BoxForge</span>
        </div>
        <p className="muted">이 서버의 컨테이너를 관리합니다. 서버를 시작할 때 정한 비밀번호를 넣으세요.</p>
        <input className="field" type="password" autoFocus autoComplete="current-password" aria-label="비밀번호" placeholder="비밀번호" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy || !password}>
          {busy ? "확인하는 중…" : "들어가기"}
        </button>
        {location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname) && (
          <p className="warn">암호화되지 않은 연결(http)입니다. 같은 네트워크의 다른 사람이 비밀번호를 볼 수 있습니다.</p>
        )}
      </form>
    </main>
  );
}
