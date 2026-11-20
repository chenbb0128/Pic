package paidan

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestQiniuTokenAndDownloadAreScopedToOneExactObject(t *testing.T) {
	provider, err := newQiniuStore("fakeAK", "fakeSK", "private-bucket", "https://upload.example.com", "https://files.example.com/")
	if err != nil {
		t.Fatal(err)
	}
	key := "paidan/v1/space-a/originals/a-file.png"
	uploadURL, token := provider.upload(key, uploadInput{MIME: "image/png", ByteLength: 1024})
	fields := strings.Split(token, ":")
	if uploadURL != "https://upload.example.com" || len(fields) != 3 || fields[0] != "fakeAK" {
		t.Fatalf("unexpected upload destination or token format")
	}
	raw, err := base64.URLEncoding.DecodeString(fields[2])
	if err != nil {
		t.Fatal(err)
	}
	var policy struct {
		Scope           string `json:"scope"`
		InsertOnly      int    `json:"insertOnly"`
		IsPrefixalScope int    `json:"isPrefixalScope"`
		FsizeLimit      int64  `json:"fsizeLimit"`
		FsizeMin        int64  `json:"fsizeMin"`
		MimeLimit       string `json:"mimeLimit"`
		Deadline        int64  `json:"deadline"`
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		t.Fatal(err)
	}
	if policy.Scope != "private-bucket:"+key || policy.InsertOnly != 1 || policy.IsPrefixalScope != 0 ||
		policy.FsizeMin != 1024 || policy.FsizeLimit != 1024 || policy.MimeLimit != "image/png" ||
		!nearExpiry(policy.Deadline, 30*time.Minute) {
		t.Fatalf("unexpected upload policy: %+v", policy)
	}
	signed, err := url.Parse(provider.download(key))
	if err != nil {
		t.Fatal(err)
	}
	deadline, err := time.ParseDuration(signed.Query().Get("e") + "s")
	if err != nil || signed.Scheme != "https" || signed.Host != "files.example.com" || signed.Path != "/"+key ||
		!strings.HasPrefix(signed.Query().Get("token"), "fakeAK:") || !nearExpiry(int64(deadline/time.Second), 15*time.Minute) ||
		len(signed.Query()) != 2 {
		t.Fatalf("unexpected private download endpoint or deadline")
	}
}

func nearExpiry(value int64, ttl time.Duration) bool {
	expiry := time.Unix(value, 0)
	return time.Until(expiry) > ttl-10*time.Second && time.Until(expiry) <= ttl
}

func TestQiniuEndpointsRequireHTTPSOrigins(t *testing.T) {
	for _, raw := range []string{"http://files.example.com", "https://files.example.com/u", "https://files.example.com/?token=example", "https://user:secret@files.example.com", "https://"} {
		if _, err := newQiniuStore("fakeAK", "fakeSK", "private-bucket", "https://upload.example.com", raw); err == nil {
			t.Fatalf("accepted invalid download endpoint %q", raw)
		}
	}
}
