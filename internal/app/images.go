package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/soulfactorx/boxforge/internal/clirunner"
	"github.com/soulfactorx/boxforge/internal/engine"
)

// PushImage uploads an image to its registry with the docker command,
// which knows the sign-ins made with "docker login". What it says arrives
// as "transfer" events.
func (a *App) PushImage(key, ref string) error {
	ref = strings.TrimSpace(ref)
	if ref == "" || strings.HasPrefix(ref, "-") {
		return fmt.Errorf("name the image to push")
	}
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	name, full, env := a.docker("push", ref)
	var last string
	err := clirunner.Run(ctx, "", env, name, full, func(line string) {
		if line = strings.TrimSpace(line); line != "" {
			last = line
			a.emit("transfer", Transfer{Key: key, Text: line})
		}
	})
	if err != nil && last != "" {
		return fmt.Errorf("%s", last)
	}
	return err
}

// ImageHistory returns the steps an image was built in, newest first, as
// `docker history` shows them: what each did and how much it added.
func (a *App) ImageHistory(ref string) ([]engine.Layer, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	list, err := a.eng().Images().History(ctx, strings.TrimSpace(ref))
	if list == nil {
		list = []engine.Layer{}
	}
	return list, err
}

// HubImage is one result of a search on Docker Hub.
type HubImage struct {
	Name     string `json:"name"`
	About    string `json:"about"`
	Stars    int    `json:"stars"`
	Official bool   `json:"official"`
}

// Where images are searched for. BOXFORGE_HUB_SEARCH names a stand-in for
// tests.
func hubSearch() string {
	if u := os.Getenv("BOXFORGE_HUB_SEARCH"); u != "" {
		return u
	}
	return "https://hub.docker.com/v2/search/repositories/"
}

// SearchImages looks for images on Docker Hub by name. BoxForge asks
// Docker Hub itself (through the proxy, if one is set), so it works with
// any engine.
func (a *App) SearchImages(query string) ([]HubImage, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []HubImage{}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", hubSearch()+"?page_size=25&query="+url.QueryEscape(query), nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Docker Hub could not be reached: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Docker Hub answered %s", res.Status)
	}
	var body struct {
		Results []struct {
			RepoName         string `json:"repo_name"`
			ShortDescription string `json:"short_description"`
			StarCount        int    `json:"star_count"`
			IsOfficial       bool   `json:"is_official"`
		} `json:"results"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&body); err != nil {
		return nil, err
	}
	list := make([]HubImage, 0, len(body.Results))
	for _, r := range body.Results {
		list = append(list, HubImage{Name: r.RepoName, About: r.ShortDescription, Stars: r.StarCount, Official: r.IsOfficial})
	}
	return list, nil
}
