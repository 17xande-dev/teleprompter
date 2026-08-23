package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// maxPeersPerRoom keeps this to a simple 1:1 call, later we can extend this
	maxPeersPerRoom = 2
	writeWait       = 10 * time.Second
	pongWait        = 60 * time.Second
	pingPeriod      = (pongWait * 9) / 10
)

var upgrader = websocket.Upgrader{
	// The frontend is served from the same origin, so the default
	// same-origin check is exactly what we want. Returning true here
	// would be required only for cross-origin clients.
	CheckOrigin: func(r *http.Request) bool {
		return r.Header.Get("Origin") == "" ||
			r.Header.Get("Origin") == "http://"+r.Host ||
			r.Header.Get("Origin") == "https://"+r.Host
	},
}

// peer is a single connected client.
type peer struct {
	conn   *websocket.Conn
	send   chan []byte
	room   *room
	polite bool
}

// room holds the peers participating in one call.
type room struct {
	mu    sync.Mutex
	name  string
	peers map[*peer]struct{}
}

// broadcast relays raw msg to every peer in the room except the sender.
func (r *room) broadcast(sender *peer, msg []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for p := range r.peers {
		if p == sender {
			continue
		}

		select {
		case p.send <- msg:
		default:
			// Slow consumer: drop it rather than block the room.
			log.Printf("room %s: dropping message to slow peer", r.name)
		}
	}
}

// hub owns all rooms and guards concurrent access to the room map
type hub struct {
	mu    sync.Mutex
	rooms map[string]*room
}

func newHub() *hub { return &hub{rooms: make(map[string]*room)} }

// join adds a peer to the named room, creating it if necessary. It returns
// the peer and whether the room had capacity.
func (h *hub) join(name string, conn *websocket.Conn) (*peer, bool) {
	h.mu.Lock()
	r, ok := h.rooms[name]
	if !ok {
		r = &room{name: name, peers: make(map[*peer]struct{})}
		h.rooms[name] = r
	}
	h.mu.Unlock()

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.peers) >= maxPeersPerRoom {
		return nil, false
	}

	// The first peer to arrive is "impolite" and drives the initial offer;
	// the second is "polite". This is the WebRTC perfect-negotiation roles.
	p := &peer{
		conn:   conn,
		send:   make(chan []byte, 16),
		room:   r,
		polite: len(r.peers) > 0,
	}
	r.peers[p] = struct{}{}
	return p, true
}

// leave removes a peer and tears down the room when it becomes empty.
func (h *hub) leave(p *peer) {
	r := p.room
	r.mu.Lock()
	delete(r.peers, p)
	empty := len(r.peers) == 0
	r.mu.Unlock()

	if empty {
		h.mu.Lock()
		delete(h.rooms, r.name)
		h.mu.Unlock()
	}
}

// signal is the envelope exchanged with clients. The "kind" field lets the
// server send control messages; "description"/"candidate" payloads are
// relayed verbatim and never parsed.
type signal struct {
	Kind string `json:"kind"`
}

func (h *hub) serveWS(w http.ResponseWriter, r *http.Request) {
	roomName := r.URL.Query().Get("room")
	if roomName == "" {
		http.Error(w, "missing room", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}

	p, ok := h.join(roomName, conn)
	if !ok {
		// Politely tell the client the room is full, then close.
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"kind": "full"}`))
		conn.Close()
		return
	}

	log.Printf("room %s: peer joined (polite=%v)", roomName, p.polite)

	// Tell the new peer its negotiation role.
	role, _ := json.Marshal(map[string]any{"kind": "role", "polite": p.polite})
	p.send <- role

	// If the room is now full, both peers are present: signal "ready" so the
	// impolite peer starts negotiation.
	p.room.broadcast(p, []byte(`{"kind":"ready"}`))

	go p.writePump()
	p.readPump(h)
}

// readPump reads messages from the websocket and relays them to the peer's
// room. It runs on the connection's own goroutine and owns all reads.

func (p *peer) readPump(h *hub) {
	defer func() {
		h.leave(p)
		close(p.send)
		p.conn.Close()
		// Let the remaining peer know the call ended.
		p.room.broadcast(p, []byte(`{"kind":"bye"}`))
		log.Printf("room %s: peer left", p.room.name)
	}()

	p.conn.SetReadLimit(64 * 1024)
	_ = p.conn.SetReadDeadline(time.Now().Add(pongWait))
	p.conn.SetPongHandler(func(string) error {
		return p.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, msg, err := p.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("read: %v", err)
			}
			return
		}
		// Validate it is JSON we understand, but relay the original bytes.
		var s signal
		if err := json.Unmarshal(msg, &s); err != nil {
			log.Printf("room %s: ignoring malformed message", p.room.name)
			continue
		}

		p.room.broadcast(p, msg)
	}
}

// writePump serializes all writes to the websocket (gorilla allows only one
// concurrent writer) and sends periodic pings to keep the connection alive.
func (p *peer) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-p.send:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// TODO: error check here?
				_ = p.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := p.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				// TODO: assuming here that the connection died so were silently returning?
				return
			}
		case <-ticker.C:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := p.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				// TODO: again, ignore err and assume connection dropped?
				return
			}
		}
	}
}

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
// STURN_URLS comma-separated (default stun:stun.l.google.com:19302)
// TURN_URLS comma-separated, e.g. "turn:turn.example.com:3478,turns:turn.example.com:5349"
// TURN_SECRET static-auth-secret shared with coturn
// TURN_TTL credential lifetime in seconds (default 3600)
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
	// credential = base64(HMAC-SHA1(secret, username)),
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

// TODO: is this abstraction necessary?
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

func main() {
	h := newHub()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.serveWS)
	mux.HandleFunc("/ice", handleICE)
	mux.Handle("/", http.FileServer(http.Dir("static")))

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Println("listening on http://localhost:8080")
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
