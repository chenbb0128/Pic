package paidan

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/qiniu/go-sdk/v7/auth"
	qiniuclient "github.com/qiniu/go-sdk/v7/client"
	"github.com/qiniu/go-sdk/v7/storage"
	"github.com/qiniu/go-sdk/v7/storagev2/apis"
	httpclient "github.com/qiniu/go-sdk/v7/storagev2/http_client"
	"github.com/qiniu/go-sdk/v7/storagev2/region"
	"github.com/qiniu/go-sdk/v7/storagev2/uplog"
)

const (
	uploadTTL   = 30 * time.Minute
	downloadTTL = 15 * time.Minute
	statTimeout = 8 * time.Second
)

var bucketName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)

type qiniuStore struct {
	creds       *auth.Credentials
	manager     *apis.Storage
	bucket      string
	uploadURL   string
	downloadURL string
}

func newQiniuStore(accessKey, secretKey, bucket, upload, download string) (*qiniuStore, error) {
	if accessKey == "" || secretKey == "" || !bucketName.MatchString(bucket) {
		return nil, errors.New("paidan requires Qiniu access key, secret key, and a valid bucket name")
	}
	uploadURL, ok := httpsOrigin(upload)
	if !ok {
		return nil, errors.New("PAIDAN_QINIU_UPLOAD_URL must be an HTTPS origin for the bucket region")
	}
	downloadURL, ok := httpsOrigin(download)
	if !ok {
		return nil, errors.New("PAIDAN_QINIU_DOWNLOAD_URL must be an HTTPS origin bound to the private bucket")
	}
	creds := auth.New(accessKey, secretKey)
	query, err := region.NewBucketRegionsQuery(httpclient.DefaultBucketHosts(), &region.BucketRegionsQueryOptions{})
	if err != nil {
		return nil, errors.New("configure Qiniu bucket region lookup")
	}
	uplog.DisableUplog()
	return &qiniuStore{
		creds: creds, bucket: bucket, uploadURL: uploadURL, downloadURL: downloadURL,
		manager: apis.NewStorage(&httpclient.Options{Credentials: creds, BucketQuery: query}),
	}, nil
}

func httpsOrigin(raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil ||
		(parsed.EscapedPath() != "" && parsed.EscapedPath() != "/") ||
		parsed.ForceQuery || parsed.RawQuery != "" || strings.Contains(raw, "#") {
		return "", false
	}
	return strings.TrimSuffix(parsed.String(), "/"), true
}

func (q *qiniuStore) upload(key string, input uploadInput) (string, string) {
	policy := storage.PutPolicy{
		Scope:      q.bucket + ":" + key,
		InsertOnly: 1,
		Expires:    uint64(uploadTTL / time.Second),
		FsizeMin:   input.ByteLength,
		FsizeLimit: input.ByteLength,
		MimeLimit:  input.MIME,
	}
	return q.uploadURL, policy.UploadToken(q.creds)
}

func (q *qiniuStore) stat(ctx context.Context, key string) (objectInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, statTimeout)
	defer cancel()

	result, err := q.manager.StatObject(ctx, &apis.StatObjectRequest{Entry: q.bucket + ":" + key}, nil)
	if err != nil {
		var code *qiniuclient.ErrorInfo
		// 612 is the Qiniu Kodo "no such file" response.
		if errors.As(err, &code) && code.Code == 612 {
			return objectInfo{}, errObjectMissing
		}
		return objectInfo{}, errUpstream
	}
	if result.Status != 0 {
		return objectInfo{}, errUpstream
	}
	return objectInfo{Size: result.Size, ETag: result.Hash}, nil
}

func (q *qiniuStore) download(key string) string {
	return storage.MakePrivateURLv2(q.creds, q.downloadURL, key, time.Now().Add(downloadTTL).Unix())
}
