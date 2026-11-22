package main

// -update: the newest release's server program, fetched and checked against
// the release's checksums, in place of this one; then the server that runs
// (started with -daemon, or as a service) is started again on it.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/soulfactorx/boxforge/internal/update"
	"github.com/soulfactorx/boxforge/internal/version"
)

func argsFile(dir string) string { return filepath.Join(dir, "server.args") }

// noteArgs keeps what -daemon started the server with, for -update to
// start it again the same way.
func noteArgs(dir string, args []string) {
	b, _ := json.Marshal(args)
	_ = os.WriteFile(argsFile(dir), b, 0o600)
}

func savedArgs(dir string) []string {
	var args []string
	b, err := os.ReadFile(argsFile(dir))
	if err != nil || json.Unmarshal(b, &args) != nil {
		return nil
	}
	return args
}

func selfUpdate(dir string, force bool) error {
	update.Server = true
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	fmt.Printf("지금 버전: %s\n새 버전을 찾는 중…\n", version.Version)
	r, err := update.Latest(ctx)
	if err != nil {
		return fmt.Errorf("새 버전을 확인하지 못했습니다: %v", err)
	}
	if !force && !update.Newer(version.Version, r.Version) {
		fmt.Printf("이미 최신 버전입니다 (%s).\n", r.Version)
		return nil
	}
	if !r.HasProgram() {
		return fmt.Errorf("%s 릴리스에 이 기기용 서버 파일(%s)이 없습니다", r.Version, update.AssetName())
	}
	exe, err := update.Program()
	if err != nil {
		return err
	}
	fmt.Printf("%s 받는 중 (%s)\n", r.Version, update.AssetName())
	last := -1
	err = update.Apply(ctx, r, func(done, total int64) {
		if total > 0 {
			if p := int(done * 100 / total); p/10 != last/10 {
				last = p
				fmt.Printf("  %d%%\n", p)
			}
		}
	})
	if err != nil {
		return fmt.Errorf("업데이트하지 못했습니다: %v", err)
	}
	keepOwner(exe)
	fmt.Printf("%s를 %s(으)로 바꿨습니다. 체크섬을 확인했습니다.\n", exe, r.Version)

	// What runs is still the old program: started again on the new one.
	if pid := runningPid(dir); pid != 0 {
		args := savedArgs(dir)
		if args == nil {
			fmt.Printf("\n-daemon 으로 실행 중인 서버(프로세스 %d)는 옛 버전입니다. -stop 한 뒤 같은 옵션으로 -daemon 하세요.\n", pid)
			return nil
		}
		fmt.Println("\n-daemon 으로 실행 중인 서버를 새 버전으로 다시 켭니다.")
		if err := stopDaemon(dir); err != nil {
			return err
		}
		return startDaemon(dir, args)
	}
	if msg := restartService(exe); msg != "" {
		fmt.Println("\n" + msg)
	}
	return nil
}
