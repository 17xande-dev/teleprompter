package main

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

// role identifies which side of a room a peer is: the single controller
// (the editor/operator page) or one of N viewers (a popup or a remote
// device showing the prompter content).
type role string

const (
	roleController role = "controller"
	roleViewer     role = "viewer"
)

// peer is a single connected client.
type peer struct {
	id   string
	role role
	conn *websocket.Conn
	send chan []byte
	room *room
}

func newPeerID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// room holds the participants of one prompter session: at most one
// controller, and any number of viewers. Viewers never talk to each other —
// the controller holds one RTCPeerConnection per viewer (a star topology) —
// so unlike a flat peer set, the room needs to know which single peer is the
// controller in order to target signaling messages correctly.
type room struct {
	mu         sync.Mutex
	name       string
	controller *peer
	viewers    map[string]*peer
}

// hub owns all rooms and guards concurrent access to the room map.
type hub struct {
	mu    sync.Mutex
	rooms map[string]*room
}

func newHub() *hub { return &hub{rooms: make(map[string]*room)} }

func (h *hub) roomFor(name string) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[name]
	if !ok {
		r = &room{name: name, viewers: make(map[string]*peer)}
		h.rooms[name] = r
	}
	return r
}

// sendTo delivers msg to the single peer with the given id, if present in
// the room. Unlike a broadcast, this never touches peers other than the
// addressed one, since with >2 participants "everyone but the sender" is no
// longer a valid routing rule for SDP/ICE exchanges.
func (r *room) sendTo(id string, msg []byte) {
	r.mu.Lock()
	target := r.peerByID(id)
	r.mu.Unlock()
	if target == nil {
		return
	}
	select {
	case target.send <- msg:
	default:
		// Slow consumer: drop it rather than block the room.
		log.Printf("room %s: dropping message to slow peer %s", r.name, id)
	}
}

// peerByID must be called with r.mu held.
func (r *room) peerByID(id string) *peer {
	if r.controller != nil && r.controller.id == id {
		return r.controller
	}
	return r.viewers[id]
}

// join adds a peer of the given role to the named room, creating the room
// if necessary, and returns it. It also fires the join notifications
// (peer-joined/waiting/viewer-list) that let the controller and viewer(s)
// discover each other and start negotiating.
func (h *hub) join(roomName string, rl role, conn *websocket.Conn) *peer {
	r := h.roomFor(roomName)
	p := &peer{id: newPeerID(), role: rl, conn: conn, send: make(chan []byte, 16), room: r}

	r.mu.Lock()
	var evicted *peer
	var existingViewers []string
	switch rl {
	case roleController:
		// A new controller replaces any existing one — most commonly the
		// operator refreshing the control page. Evicting the stale
		// connection (rather than rejecting the new one) turns what used to
		// be a permanently orphaned popup into a brief renegotiation blip:
		// viewers see peer-left for the old controller id, then
		// peer-joined for the new one.
		evicted = r.controller
		r.controller = p
		for id := range r.viewers {
			existingViewers = append(existingViewers, id)
		}
	case roleViewer:
		r.viewers[p.id] = p
	}
	controller := r.controller
	r.mu.Unlock()

	if evicted != nil {
		evicted.conn.Close()
	}

	switch rl {
	case roleController:
		p.send <- encode(msgViewerList{Kind: "viewer-list", Peers: existingViewers})
	case roleViewer:
		if controller != nil {
			p.send <- encode(msgPeerEvent{Kind: "peer-joined", From: controller.id})
			controller.room.sendTo(controller.id, encode(msgPeerEvent{Kind: "peer-joined", From: p.id}))
		} else {
			p.send <- encode(msgKind{Kind: "waiting"})
		}
	}

	return p
}

// leave removes a peer from its room, notifying whoever needs to know, and
// tears the room down once it holds nobody.
func (h *hub) leave(p *peer) {
	r := p.room
	r.mu.Lock()
	var notify []*peer
	switch p.role {
	case roleController:
		if r.controller == p {
			r.controller = nil
		}
		for _, v := range r.viewers {
			notify = append(notify, v)
		}
	case roleViewer:
		delete(r.viewers, p.id)
		if r.controller != nil {
			notify = append(notify, r.controller)
		}
	}
	empty := r.controller == nil && len(r.viewers) == 0
	r.mu.Unlock()

	msg := encode(msgPeerEvent{Kind: "peer-left", From: p.id})
	for _, n := range notify {
		r.sendTo(n.id, msg)
	}

	if empty {
		h.mu.Lock()
		delete(h.rooms, r.name)
		h.mu.Unlock()
	}
}
