package library

import (
	"database/sql"
	"fmt"
	"net/http"
	"os"
)

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
	return NewHandler(&MySQLStore{DB: db}, Options{Username: os.Getenv("PIC_USERNAME"), Password: os.Getenv("PIC_PASSWORD"), ToolPassword: os.Getenv("PIC_TOOL_PASSWORD"), SessionKey: os.Getenv("PIC_SESSION_KEY"), Origin: origin, DataDir: os.Getenv("PIC_DATA_DIR"), SecureCookie: secure})
}
