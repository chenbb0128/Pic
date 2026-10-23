// Package library implements the single-store shared document library.
package library

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

var ErrInvalid = errors.New("invalid document")
var ErrConflict = errors.New("document version conflict")
var ErrNotFound = errors.New("not found")

func validID(id string) bool {
	if len(id) != 32 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

// ValidateSnapshot accepts a self-contained editor snapshot, never transient URLs.
func ValidateSnapshot(kind string, raw json.RawMessage) ([]string, error) {
	bad := func() ([]string, error) { return nil, ErrInvalid }
	if (kind != "project" && kind != "template") || len(raw) > 2<<20 {
		return bad()
	}
	var root map[string]any
	if json.Unmarshal(raw, &root) != nil || root["schemaVersion"] != float64(1) || root["editor"] != "heart-star" {
		return bad()
	}
	tpl, ok := root["template"].(map[string]any)
	if !ok {
		return bad()
	}
	w, wok := tpl["w"].(float64)
	h, hok := tpl["h"].(float64)
	if !wok || !hok || w < 1 || h < 1 || w > 12000 || h > 12000 || w*h > 40e6 {
		return bad()
	}
	slots, sok := tpl["slots"].([]any)
	states, tok := root["states"].([]any)
	photos, pok := root["photos"].([]any)
	if !sok || !tok || !pok || len(slots) < 1 || len(slots) > 1000 || len(states) != len(slots) || len(photos) != len(slots) {
		return bad()
	}
	for i, slot := range slots {
		if _, ok := slot.(map[string]any); !ok {
			return bad()
		}
		if _, ok := states[i].(map[string]any); !ok {
			return bad()
		}
		if kind == "template" && photos[i] != nil {
			return bad()
		}
		if photos[i] != nil {
			ref, ok := photos[i].(map[string]any)
			if !ok {
				return bad()
			}
			id, _ := ref["fileId"].(string)
			if !validID(id) {
				return bad()
			}
		}
	}
	settings, ok := root["settings"].(map[string]any)
	if !ok {
		return bad()
	}
	if dpi := settings["dpi"]; dpi != float64(150) && dpi != float64(300) && dpi != float64(500) && dpi != float64(600) {
		return bad()
	}
	if tpl["text"] != true {
		ref, ok := tpl["image"].(map[string]any)
		if !ok {
			return bad()
		}
		id, _ := ref["fileId"].(string)
		if !validID(id) {
			return bad()
		}
	}
	refs := map[string]bool{}
	var walk func(any, int) error
	walk = func(value any, depth int) error {
		if depth > 32 {
			return ErrInvalid
		}
		switch v := value.(type) {
		case map[string]any:
			for key, child := range v {
				if key == "src" || key == "url" {
					return fmt.Errorf("%w: transient URL", ErrInvalid)
				}
				if key == "fileId" {
					id, ok := child.(string)
					if !ok || !validID(id) {
						return ErrInvalid
					}
					refs[id] = true
				}
				if key == "image" {
					if _, ok := child.(map[string]any); !ok && child != nil {
						return ErrInvalid
					}
				}
				if err := walk(child, depth+1); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range v {
				if err := walk(child, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(root, 0); err != nil {
		return nil, err
	}
	if len(refs) > 600 {
		return bad()
	}
	ids := make([]string, 0, len(refs))
	for id := range refs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}
