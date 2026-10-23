package library

import (
	"encoding/json"
	"testing"
)

func snapshot() json.RawMessage {
	return json.RawMessage(`{"schemaVersion":1,"editor":"heart-star","template":{"w":200,"h":300,"slots":[{"x":50,"y":50,"w":40,"h":40}],"image":{"fileId":"0123456789abcdef0123456789abcdef"}},"states":[{"size":0.62}],"photos":[null],"settings":{"dpi":600}}`)
}

func TestSnapshotReferencesAreCollectedAndDeduplicated(t *testing.T) {
	ids, err := ValidateSnapshot("project", snapshot())
	if err != nil || len(ids) != 1 || ids[0] != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("references=%v, err=%v", ids, err)
	}
}

func TestTemplateCannotContainCustomerPhotos(t *testing.T) {
	var doc map[string]any
	json.Unmarshal(snapshot(), &doc)
	doc["photos"] = []any{map[string]any{"fileId": "0123456789abcdef0123456789abcdef"}}
	raw, _ := json.Marshal(doc)
	if _, err := ValidateSnapshot("template", raw); err == nil {
		t.Fatal("template accepted customer photo")
	}
}

func TestSnapshotRejectsUnsupportedOrIncompleteDocuments(t *testing.T) {
	for _, raw := range []string{`{}`, `[]`, `{"schemaVersion":2}`, `null`} {
		if _, err := ValidateSnapshot("project", json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	for _, change := range []func(map[string]any){
		func(d map[string]any) { d["photos"] = []any{} },
		func(d map[string]any) { d["states"] = []any{} },
		func(d map[string]any) {
			d["template"].(map[string]any)["image"] = map[string]any{"fileId": "../secret"}
		},
		func(d map[string]any) {
			d["states"] = []any{map[string]any{"image": map[string]any{"src": "blob:temporary"}}}
		},
	} {
		var doc map[string]any
		json.Unmarshal(snapshot(), &doc)
		change(doc)
		raw, _ := json.Marshal(doc)
		if _, err := ValidateSnapshot("project", raw); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
