package config

import "time"

type Config struct {
	App           AppConfig           `mapstructure:"app"`
	HTTP          HTTPConfig          `mapstructure:"http"`
	Database      DatabaseConfig      `mapstructure:"database"`
	Redis         RedisConfig         `mapstructure:"redis"`
	Worker        WorkerConfig        `mapstructure:"worker"`
	Observability ObservabilityConfig `mapstructure:"observability"`
	Log           LogConfig           `mapstructure:"log"`
}

type AppConfig struct {
	Name string `mapstructure:"name"`
	Env  string `mapstructure:"env"`
}

type HTTPConfig struct {
	Addr              string        `mapstructure:"addr"`
	ReadHeaderTimeout time.Duration `mapstructure:"read_header_timeout"`
	ReadTimeout       time.Duration `mapstructure:"read_timeout"`
	WriteTimeout      time.Duration `mapstructure:"write_timeout"`
	IdleTimeout       time.Duration `mapstructure:"idle_timeout"`
	ShutdownTimeout   time.Duration `mapstructure:"shutdown_timeout"`
	MaxHeaderBytes    int           `mapstructure:"max_header_bytes"`
	MaxBodyBytes      int64         `mapstructure:"max_body_bytes"`
	TrustedProxies    []string      `mapstructure:"trusted_proxies"`
	CORS              CORSConfig    `mapstructure:"cors"`
}

type CORSConfig struct {
	AllowedOrigins   []string `mapstructure:"allowed_origins"`
	AllowedMethods   []string `mapstructure:"allowed_methods"`
	AllowedHeaders   []string `mapstructure:"allowed_headers"`
	AllowCredentials bool     `mapstructure:"allow_credentials"`
}

type DatabaseConfig struct {
	Enabled         bool          `mapstructure:"enabled"`
	Driver          string        `mapstructure:"driver"`
	DSN             string        `mapstructure:"dsn"`
	MaxOpenConns    int           `mapstructure:"max_open_conns"`
	MaxIdleConns    int           `mapstructure:"max_idle_conns"`
	ConnMaxLifetime time.Duration `mapstructure:"conn_max_lifetime"`
	ConnMaxIdleTime time.Duration `mapstructure:"conn_max_idle_time"`
	PingTimeout     time.Duration `mapstructure:"ping_timeout"`
}

type RedisConfig struct {
	Enabled      bool          `mapstructure:"enabled"`
	Addr         string        `mapstructure:"addr"`
	Username     string        `mapstructure:"username"`
	Password     string        `mapstructure:"password"`
	DB           int           `mapstructure:"db"`
	DialTimeout  time.Duration `mapstructure:"dial_timeout"`
	ReadTimeout  time.Duration `mapstructure:"read_timeout"`
	WriteTimeout time.Duration `mapstructure:"write_timeout"`
	PingTimeout  time.Duration `mapstructure:"ping_timeout"`
	PoolSize     int           `mapstructure:"pool_size"`
	MinIdleConns int           `mapstructure:"min_idle_conns"`
	KeyPrefix    string        `mapstructure:"key_prefix"`
}

type WorkerConfig struct {
	Enabled         bool           `mapstructure:"enabled"`
	Concurrency     int            `mapstructure:"concurrency"`
	ShutdownTimeout time.Duration  `mapstructure:"shutdown_timeout"`
	Queues          map[string]int `mapstructure:"queues"`
}

type ObservabilityConfig struct {
	Metrics MetricsConfig `mapstructure:"metrics"`
	Tracing TracingConfig `mapstructure:"tracing"`
}

type MetricsConfig struct {
	Enabled   bool   `mapstructure:"enabled"`
	Path      string `mapstructure:"path"`
	Namespace string `mapstructure:"namespace"`
}

type TracingConfig struct {
	Enabled     bool    `mapstructure:"enabled"`
	Exporter    string  `mapstructure:"exporter"`
	Endpoint    string  `mapstructure:"endpoint"`
	Insecure    bool    `mapstructure:"insecure"`
	SampleRatio float64 `mapstructure:"sample_ratio"`
}

type LogConfig struct {
	Level string `mapstructure:"level"`
}

func (c Config) SanitizedSummary() map[string]any {
	return map[string]any{
		"app_name":                    c.App.Name,
		"env":                         c.App.Env,
		"http_addr":                   c.HTTP.Addr,
		"read_header":                 c.HTTP.ReadHeaderTimeout.String(),
		"read":                        c.HTTP.ReadTimeout.String(),
		"write":                       c.HTTP.WriteTimeout.String(),
		"idle":                        c.HTTP.IdleTimeout.String(),
		"shutdown":                    c.HTTP.ShutdownTimeout.String(),
		"max_header_bytes":            c.HTTP.MaxHeaderBytes,
		"max_body_bytes":              c.HTTP.MaxBodyBytes,
		"trusted_proxies":             len(c.HTTP.TrustedProxies),
		"cors_origins":                len(c.HTTP.CORS.AllowedOrigins),
		"cors_credentials":            c.HTTP.CORS.AllowCredentials,
		"database_enabled":            c.Database.Enabled,
		"database_driver":             c.Database.Driver,
		"database_dsn":                redactSecret(c.Database.DSN),
		"database_max_open":           c.Database.MaxOpenConns,
		"database_max_idle":           c.Database.MaxIdleConns,
		"redis_enabled":               c.Redis.Enabled,
		"redis_addr":                  c.Redis.Addr,
		"redis_username":              c.Redis.Username,
		"redis_password":              redactSecret(c.Redis.Password),
		"redis_db":                    c.Redis.DB,
		"redis_pool_size":             c.Redis.PoolSize,
		"redis_key_prefix":            c.Redis.KeyPrefix,
		"worker_enabled":              c.Worker.Enabled,
		"worker_concurrency":          c.Worker.Concurrency,
		"worker_queues":               len(c.Worker.Queues),
		"metrics_enabled":             c.Observability.Metrics.Enabled,
		"metrics_path":                c.Observability.Metrics.Path,
		"metrics_namespace":           c.Observability.Metrics.Namespace,
		"tracing_enabled":             c.Observability.Tracing.Enabled,
		"tracing_exporter":            c.Observability.Tracing.Exporter,
		"tracing_endpoint_configured": c.Observability.Tracing.Endpoint != "",
		"tracing_insecure":            c.Observability.Tracing.Insecure,
		"tracing_sample_ratio":        c.Observability.Tracing.SampleRatio,
		"log_level":                   c.Log.Level,
	}
}

func redactSecret(value string) string {
	if value == "" {
		return ""
	}
	return "<redacted>"
}
