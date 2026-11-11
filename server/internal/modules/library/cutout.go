package library

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

// PicWish segmentation upstream. sync=1 keeps a single round trip; the 1-hour
// result link is downloaded immediately and re-served from our private assets.
const (
	picWishDefaultURL     = "https://techsz.aoscdn.com"
	picWishClientTimeout  = 90 * time.Second
	picWishMaxResultBytes = 50 << 20
	cutoutMaxSide         = 4096
	cutoutConcurrency     = 2
)

type cutoutResult struct {
	Asset
	Cached bool `json:"cached"`
}

type upstreamError struct {
	status  int
	message string
}

func (e *upstreamError) Error() string { return e.message }

type segmentResult struct {
	data          []byte
	width, height int
}

func (h *handler) cutout(w http.ResponseWriter, r *http.Request) {
	if h.opts.PicWishAPIKey == "" {
		h.fail(w, http.StatusServiceUnavailable, "AI 抠图未配置服务密钥，请联系店家")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxImageBytes+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		if r.MultipartForm != nil {
			r.MultipartForm.RemoveAll()
		}
		h.fail(w, http.StatusRequestEntityTooLarge, "图片过大（单张最多 25 MB）或上传无效")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, _, err := r.FormFile("file")
	if err != nil {
		h.fail(w, http.StatusBadRequest, "请通过 multipart 的 file 字段上传图片")
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxImageBytes+1))
	if err != nil {
		h.fail(w, http.StatusBadRequest, "图片读取失败，请重新上传")
		return
	}
	if len(data) > maxImageBytes {
		h.fail(w, http.StatusRequestEntityTooLarge, "单张图片最多 25 MB")
		return
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 {
		h.fail(w, http.StatusBadRequest, "请选择 PNG、JPEG 或 GIF 图片，其他格式请先转为 PNG")
		return
	}
	if cfg.Width > cutoutMaxSide || cfg.Height > cutoutMaxSide {
		h.fail(w, http.StatusBadRequest, "AI 抠图最大支持 4096×4096 像素，请先缩小图片")
		return
	}
	// Content-addressed cache: identical photo bytes never bill twice.
	sum := sha256.Sum256(data)
	id := hex.EncodeToString(sum[:16])
	if asset, err := h.store.Asset(r.Context(), id); err == nil {
		if _, statErr := os.Stat(filepath.Join(h.opts.DataDir, id)); statErr == nil {
			h.reply(w, http.StatusOK, cutoutResult{Asset: asset, Cached: true})
			return
		}
	}
	if !h.reserveCutout() {
		h.fail(w, http.StatusTooManyRequests, "今日 AI 抠图次数已用完，请明天再试或联系店家")
		return
	}
	select {
	case h.cutoutSem <- struct{}{}:
		defer func() { <-h.cutoutSem }()
	case <-r.Context().Done():
		h.releaseCutout()
		h.fail(w, http.StatusGatewayTimeout, "AI 抠图排队超时，请稍后重试")
		return
	}
	result, err := h.picWishSegment(r.Context(), data, format)
	if err != nil {
		h.releaseCutout()
		var upstream *upstreamError
		if errors.As(err, &upstream) {
			h.fail(w, upstream.status, upstream.message)
			return
		}
		slog.Error("cutout upstream failed", "error", err)
		h.fail(w, http.StatusBadGateway, "AI 抠图暂时不可用，请稍后重试")
		return
	}
	path := filepath.Join(h.opts.DataDir, id)
	if writeErr := writeAssetFile(path, result.data); writeErr != nil && !errors.Is(writeErr, os.ErrExist) {
		slog.Error("cutout result write failed", "error", writeErr)
		h.fail(w, http.StatusInternalServerError, "AI 抠图结果保存失败，请稍后重试")
		return
	}
	asset := Asset{ID: id, MIME: "image/png", Size: int64(len(result.data)), Width: result.width, Height: result.height}
	if err := h.store.CreateAsset(r.Context(), asset); err != nil {
		// A racing request may have inserted the same cache row first; that is a hit.
		if existing, lookupErr := h.store.Asset(r.Context(), id); lookupErr == nil {
			asset = existing
		} else {
			os.Remove(path)
			slog.Error("cutout asset record failed", "error", err)
			h.fail(w, http.StatusInternalServerError, "AI 抠图结果保存失败，请稍后重试")
			return
		}
	}
	slog.Info("cutout processed", "id", id, "width", cfg.Width, "height", cfg.Height, "bytes", len(data))
	h.reply(w, http.StatusOK, cutoutResult{Asset: asset, Cached: false})
}

func writeAssetFile(path string, data []byte) error {
	dest, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = dest.Write(data); err == nil {
		err = dest.Sync()
	}
	closeErr := dest.Close()
	if err == nil {
		err = closeErr
	}
	return err
}

type picWishSegmentResponse struct {
	Status  int    `json:"status"`
	Message string `json:"message"`
	Data    struct {
		State int    `json:"state"`
		Image string `json:"image"`
	} `json:"data"`
}

func (h *handler) picWishSegment(ctx context.Context, data []byte, format string) (segmentResult, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, err := writer.CreateFormFile("image_file", "photo."+extName(format))
	if err != nil {
		return segmentResult{}, err
	}
	if _, err = file.Write(data); err != nil {
		return segmentResult{}, err
	}
	for field, value := range map[string]string{"sync": "1", "type": "stamp", "return_type": "1", "output_type": "2", "crop": "0", "format": "png"} {
		if err = writer.WriteField(field, value); err != nil {
			return segmentResult{}, err
		}
	}
	if err = writer.Close(); err != nil {
		return segmentResult{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, h.opts.PicWishURL+"/api/tasks/visual/segmentation", &body)
	if err != nil {
		return segmentResult{}, err
	}
	request.Header.Set("X-API-KEY", h.opts.PicWishAPIKey)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := h.picWish.Do(request)
	if err != nil {
		return segmentResult{}, &upstreamError{status: http.StatusBadGateway, message: "AI 抠图服务连接失败，请稍后重试"}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		switch response.StatusCode {
		case http.StatusUnauthorized:
			return segmentResult{}, &upstreamError{status: http.StatusBadGateway, message: "AI 抠图服务密钥无效，请联系店家"}
		case http.StatusTooManyRequests:
			return segmentResult{}, &upstreamError{status: http.StatusTooManyRequests, message: "AI 抠图请求过于频繁，请稍后再试"}
		case http.StatusRequestEntityTooLarge:
			return segmentResult{}, &upstreamError{status: http.StatusRequestEntityTooLarge, message: "图片过大，AI 抠图最多支持 25 MB"}
		default:
			return segmentResult{}, &upstreamError{status: http.StatusBadGateway, message: "AI 抠图服务暂时不可用，请稍后重试"}
		}
	}
	var parsed picWishSegmentResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&parsed); err != nil || parsed.Data.State != 1 || parsed.Data.Image == "" {
		return segmentResult{}, &upstreamError{status: http.StatusBadGateway, message: "AI 抠图处理失败，请重试或更换图片"}
	}
	return h.picWishDownload(ctx, parsed.Data.Image)
}

func (h *handler) picWishDownload(ctx context.Context, link string) (segmentResult, error) {
	parsed, err := url.Parse(link)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return segmentResult{}, &upstreamError{status: http.StatusBadGateway, message: "AI 抠图返回的结果无效，请重试"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return segmentResult{}, err
	}
	response, err := h.picWish.Do(request)
	if err != nil {
		return segmentResult{}, &upstreamError{status: http.StatusBadGateway, message: "AI 抠图结果下载失败，请稍后重试"}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return segmentResult{}, &upstreamError{status: http.StatusBadGateway, message: "AI 抠图结果下载失败，请稍后重试"}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, picWishMaxResultBytes+1))
	if err != nil || len(data) == 0 || len(data) > picWishMaxResultBytes {
		return segmentResult{}, &upstreamError{status: http.StatusBadGateway, message: "AI 抠图结果下载失败，请稍后重试"}
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 {
		return segmentResult{}, &upstreamError{status: http.StatusBadGateway, message: "AI 抠图返回的结果无效，请重试"}
	}
	return segmentResult{data: data, width: cfg.Width, height: cfg.Height}, nil
}

func extName(format string) string {
	switch format {
	case "jpeg":
		return "jpg"
	case "gif":
		return "gif"
	default:
		return "png"
	}
}

func (h *handler) reserveCutout() bool {
	limit := h.opts.PicWishDailyLimit
	h.cutoutMu.Lock()
	defer h.cutoutMu.Unlock()
	today := time.Now().Format("2006-01-02")
	if h.cutoutDay != today {
		h.cutoutDay, h.cutoutCount = today, 0
	}
	if limit > 0 && h.cutoutCount >= limit {
		return false
	}
	h.cutoutCount++
	return true
}

// Upstream failures should not consume the daily budget.
func (h *handler) releaseCutout() {
	h.cutoutMu.Lock()
	defer h.cutoutMu.Unlock()
	if h.cutoutCount > 0 {
		h.cutoutCount--
	}
}
