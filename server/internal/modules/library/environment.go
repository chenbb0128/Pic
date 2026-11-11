package library

import (
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// TODO(test-only): 临时 PicWish 测试密钥，本地直跑 go run 时兜底；提交前删除此行。
const picWishTestKeyFallback = "wxfcm9m0237phwxwo"

func picWishKey() string {
	if key := os.Getenv("PIC_PICWISH_API_KEY"); key != "" {
		return key
	}
	return picWishTestKeyFallback
}

// Credentials intentionally stay outside the base config's logging summary.
func FromEnvironment(db *sql.DB) (http.Handler, error) {
	if os.Getenv("PIC_LIBRARY_ENABLED") != "true" {
		return nil, nil
	}
	if db == nil {
		return nil, fmt.Errorf("PIC_LIBRARY_ENABLED requires MySQL")
	}
	secure := os.Getenv("PIC_COOKIE_SECURE") != "false"
	origin := os.Getenv("PIC_ORIGIN")
	if !secure && origin != "http://127.0.0.1:5173" && origin != "http://localhost:5173" {
		return nil, fmt.Errorf("insecure cookie only allowed for local Vite origins")
	}
	picWishDailyLimit := 0
	if raw := strings.TrimSpace(os.Getenv("PIC_PICWISH_DAILY_LIMIT")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 0 {
			return nil, fmt.Errorf("PIC_PICWISH_DAILY_LIMIT must be a non-negative integer")
		}
		picWishDailyLimit = limit
	}
	return NewHandler(&MySQLStore{DB: db}, Options{Username: os.Getenv("PIC_USERNAME"), Password: os.Getenv("PIC_PASSWORD"), ToolPassword: os.Getenv("PIC_TOOL_PASSWORD"), SessionKey: os.Getenv("PIC_SESSION_KEY"), Origin: origin, DataDir: os.Getenv("PIC_DATA_DIR"), SecureCookie: secure,
		PicWishAPIKey: picWishKey(), PicWishURL: os.Getenv("PIC_PICWISH_API_URL"), PicWishDailyLimit: picWishDailyLimit})
}
