package library

import (
	"context"
	"encoding/json"
	"time"
)

type Session struct {
	Credential string
	Expires    time.Time
}
type Asset struct {
	ID     string `json:"id"`
	MIME   string `json:"mime"`
	Size   int64  `json:"size"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}
type Document struct {
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`
	Name        string          `json:"name"`
	Number      string          `json:"number,omitempty"`
	ThumbnailID string          `json:"thumbnailId,omitempty"`
	ResultID    string          `json:"resultId,omitempty"`
	Version     int64           `json:"version"`
	Snapshot    json.RawMessage `json:"snapshot,omitempty"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}
type Store interface {
	SaveSession(context.Context, string, string, time.Time) error
	Session(context.Context, string) (Session, error)
	DeleteSession(context.Context, string) error
	CreateAsset(context.Context, Asset) error
	Asset(context.Context, string) (Asset, error)
	List(context.Context, string, int, string) ([]Document, error)
	Get(context.Context, string, string) (Document, error)
	Save(context.Context, Document, []string, int64) (Document, error)
	Delete(context.Context, string, string, int64) error
}
