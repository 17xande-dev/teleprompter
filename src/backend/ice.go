package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// iceServer mirrors the browser's RTCIceServer dictionary.
type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// iceServers builds the ICE configuration handed to clients. STUN is always
// included; TURN is added only when TURN_URLS and TURN_SECRET are set, using
// short-lived HMAC credentials (the coturn "use-auth-secret" / TURN REST API
// scheme). Credentials are never long-lived and never baked into the frontend.
//
// Env:
//
//	STUN_URLS   comma-separated (default stun:stun.l.google.com:19302)
//	TURN_URLS   comma-separated, e.g. "turn:turn.example.com:3478,turns:turn.example.com:5349"
//	TURN_SECRET static-auth-secret shared with coturn
//	TURN_TTL    credential lifetime in seconds (default 3600)
func iceServers(now time.Time) []iceServer {
	servers := []iceServer{{URLs: splitCSV(getenv("STUN_URLS", "stun:stun.l.google.com:19302"))}}

	turnURLs := os.Getenv("TURN_URLS")
	secret := os.Getenv("TURN_SECRET")
	if turnURLs == "" || secret == "" {
		return servers
	}

	ttl, err := strconv.Atoi(getenv("TURN_TTL", "3600"))
	if err != nil || ttl <= 0 {
		ttl = 3600
	}

	// coturn expects username = "<expiry-unix-ts>[:<id>]" and
	// credential = base64(HMAC-SHA1(secret, username)).
	username := strconv.FormatInt(now.Add(time.Duration(ttl)*time.Second).Unix(), 10)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	return append(servers, iceServer{
		URLs:       splitCSV(turnURLs),
		Username:   username,
		Credential: credential,
	})
}

func splitCSV(s string) []string {
	var out []string
	for part := range strings.SplitSeq(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// handleICE returns fresh ICE servers (with ephemeral TURN credentials) for a
// client about to open a peer connection.
func handleICE(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"iceServers": iceServers(time.Now())})
}
