package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
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

// clientSignal is the envelope a client sends: "to" addresses a single
// other peer in the room (this replaces broadcast-to-everyone-but-sender,
// which stopped being correct once a room can hold more than 2 peers). The
// server never inspects "description"/"candidate" beyond this envelope —
// it relays the original bytes verbatim to the addressed peer.
type clientSignal struct {
	Kind string `json:"kind"`
	To   string `json:"to"`
}

// Server -> client control envelopes. Kept as separate small structs
// (rather than one do-everything struct) so each only carries the fields
// it needs.
type msgKind struct {
	Kind string `json:"kind"`
}

type msgPeerEvent struct {
	Kind string `json:"kind"`
	From string `json:"from"`
}

type msgViewerList struct {
	Kind  string   `json:"kind"`
	Peers []string `json:"peers"`
}

type msgWelcome struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

func encode(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Fatalf("encode: %v", err) // programmer error: v must always be JSON-marshalable
	}
	return b
}

func (h *hub) serveWS(w http.ResponseWriter, r *http.Request) {
	roomName := r.URL.Query().Get("room")
	if roomName == "" {
		http.Error(w, "missing room", http.StatusBadRequest)
		return
	}

	var rl role
	switch r.URL.Query().Get("role") {
	case "controller":
		rl = roleController
	case "viewer":
		rl = roleViewer
	default:
		http.Error(w, "role must be controller or viewer", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}

	p := h.join(roomName, rl, conn)
	log.Printf("room %s: %s %s joined", roomName, rl, p.id)

	// Tell the peer its own id, so it can stamp/route further signaling and
	// (as the controller) address messages per viewer.
	p.send <- encode(msgWelcome{Kind: "welcome", ID: p.id})

	go p.writePump()
	p.readPump(h)
}

// readPump reads messages from the websocket and relays them to their
// addressed peer. It runs on the connection's own goroutine and owns all
// reads.
func (p *peer) readPump(h *hub) {
	defer func() {
		h.leave(p)
		close(p.send)
		p.conn.Close()
		log.Printf("room %s: %s %s left", p.room.name, p.role, p.id)
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

		var s clientSignal
		if err := json.Unmarshal(msg, &s); err != nil || s.To == "" {
			log.Printf("room %s: ignoring malformed/untargeted message", p.room.name)
			continue
		}

		// Relay the original bytes verbatim — the server never parses the
		// SDP/ICE payload itself, only enough of the envelope to route it.
		p.room.sendTo(s.To, msg)
	}
}

// writePump serializes all writes to the websocket (gorilla allows only
// one concurrent writer) and sends periodic pings to keep the connection
// alive.
func (p *peer) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-p.send:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = p.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := p.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := p.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
