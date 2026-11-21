package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/pressly/goose/v3"

	"github.com/chenbb0128/Pic/server/internal/config"
	"github.com/chenbb0128/Pic/server/internal/modules/vagaga"
	"github.com/chenbb0128/Pic/server/internal/platform/database"
)

func main() {
	configPath := flag.String("config", "", "path to a YAML configuration file")
	target := flag.String("target", "app", "migration target: app or vagaga")
	migrationsDir := flag.String("dir", "", "override the migration directory")
	command := flag.String("command", "status", "migration command: up, down, status, redo")
	dsnOverride := flag.String("dsn", "", "optional main application database DSN override")
	flag.Parse()

	switch *target {
	case "vagaga", "paidan":
		if *dsnOverride != "" {
			slog.Error("vagaga migration expects PAIDAN_MYSQL_DSN")
			os.Exit(1)
		}
		dir := *migrationsDir
		if dir == "" {
			dir = "database/vagaga_migrations"
		}
		if err := migrateVagaga(dir, *command); err != nil {
			slog.Error("vagaga migration failed", "command", *command, "error", err)
			os.Exit(1)
		}
		return
	case "app":
		if *migrationsDir == "" {
			*migrationsDir = "database/migrations"
		}
	default:
		slog.Error("unsupported migration target")
		os.Exit(1)
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		slog.Error("load config failed", "error", err)
		os.Exit(1)
	}

	dsn := strings.TrimSpace(*dsnOverride)
	if dsn == "" {
		dsn = strings.TrimSpace(cfg.Database.DSN)
	}
	if dsn == "" {
		slog.Error("database dsn is required for migrations")
		os.Exit(1)
	}
	if cfg.Database.Driver != "mysql" {
		slog.Error("unsupported migration database driver", "driver", cfg.Database.Driver)
		os.Exit(1)
	}

	dsn, err = database.NormalizeMySQLDSN(dsn)
	if err != nil {
		slog.Error("normalize mysql dsn failed", "error", err)
		os.Exit(1)
	}

	db, err := sql.Open(cfg.Database.Driver, dsn)
	if err != nil {
		slog.Error("open database failed", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := db.Close(); err != nil {
			slog.Error("close database failed", "error", err)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), cfg.Database.PingTimeout)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		slog.Error("ping database failed", "error", err)
		os.Exit(1)
	}

	if err := goose.SetDialect(cfg.Database.Driver); err != nil {
		slog.Error("set goose dialect failed", "error", err)
		os.Exit(1)
	}

	if err := runMigrationCommand(db, *migrationsDir, *command); err != nil {
		slog.Error("migration failed", "command", *command, "error", err)
		os.Exit(1)
	}
}

func migrateVagaga(dir, command string) error {
	dsn := strings.TrimSpace(os.Getenv("PAIDAN_MYSQL_DSN"))
	if dsn == "" {
		return fmt.Errorf("PAIDAN_MYSQL_DSN is required")
	}
	db, err := vagaga.OpenDatabase(dsn)
	if err != nil {
		return err
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("vagaga MySQL connection failed")
	}
	if err := goose.SetDialect("mysql"); err != nil {
		return err
	}
	goose.SetTableName("paidan_goose_db_version")
	return runMigrationCommand(db, dir, command)
}

func runMigrationCommand(db *sql.DB, dir string, command string) error {
	switch strings.ToLower(strings.TrimSpace(command)) {
	case "up":
		return goose.Up(db, dir)
	case "down":
		return goose.Down(db, dir)
	case "status":
		return goose.Status(db, dir)
	case "redo":
		return goose.Redo(db, dir)
	default:
		return fmt.Errorf("unsupported migration command %q", command)
	}
}
