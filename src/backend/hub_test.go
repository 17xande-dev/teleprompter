package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// newTestConn returns a real, connected *websocket.Conn. hub.join only ever
// calls Close() on a peer's connection (to evict a stale controller), so a
// live connection is all these tests need — nothing is read or written over
// it here, and using the real gorilla/websocket handshake (rather than a
// hand-rolled fake) means Close() behaves exactly as it does in production.
func newTestConn(t *testing.T) *websocket.Conn {
	t.Helper()
	var upgrader websocket.Upgrader
	connCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		connCh <- c
	}))
	t.Cleanup(srv.Close)

	wsURL := "ws" + srv.URL[len("http"):]
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { client.Close() })

	select {
	case c := <-connCh:
		t.Cleanup(func() { c.Close() })
		return c
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for server-side connection")
		return nil
	}
}

func recvMsg(t *testing.T, p *peer) map[string]any {
	t.Helper()
	select {
	case b := <-p.send:
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatalf("unmarshal %s: %v", b, err)
		}
		return m
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for message")
		return nil
	}
}

func TestJoinViewer_WaitingWhenNoController(t *testing.T) {
	h := newHub()
	v := h.join("room1", roleViewer, newTestConn(t))
	if msg := recvMsg(t, v); msg["kind"] != "waiting" {
		t.Fatalf("kind = %v, want waiting", msg["kind"])
	}
}

func TestJoinController_ThenViewer_NotifiesBothSides(t *testing.T) {
	h := newHub()
	c := h.join("room1", roleController, newTestConn(t))
	if msg := recvMsg(t, c); msg["kind"] != "viewer-list" {
		t.Fatalf("controller kind = %v, want viewer-list", msg["kind"])
	}

	v := h.join("room1", roleViewer, newTestConn(t))
	if msg := recvMsg(t, v); msg["kind"] != "peer-joined" || msg["from"] != c.id {
		t.Fatalf("viewer msg = %v, want peer-joined from %s", msg, c.id)
	}
	if msg := recvMsg(t, c); msg["kind"] != "peer-joined" || msg["from"] != v.id {
		t.Fatalf("controller msg = %v, want peer-joined from %s", msg, v.id)
	}
}

func TestJoinController_ExistingViewersListed(t *testing.T) {
	h := newHub()
	v := h.join("room1", roleViewer, newTestConn(t))
	recvMsg(t, v) // waiting

	c := h.join("room1", roleController, newTestConn(t))
	msg := recvMsg(t, c)
	if msg["kind"] != "viewer-list" {
		t.Fatalf("kind = %v, want viewer-list", msg["kind"])
	}
	peers, _ := msg["peers"].([]any)
	if len(peers) != 1 || peers[0] != v.id {
		t.Fatalf("peers = %v, want [%s]", peers, v.id)
	}
	// The pre-existing viewer should also learn about the new controller.
	if msg := recvMsg(t, v); msg["kind"] != "peer-joined" || msg["from"] != c.id {
		t.Fatalf("viewer msg = %v, want peer-joined from %s", msg, c.id)
	}
}

func TestJoinController_EvictsPreviousController(t *testing.T) {
	h := newHub()
	first := h.join("room1", roleController, newTestConn(t))
	recvMsg(t, first) // viewer-list

	second := h.join("room1", roleController, newTestConn(t))
	recvMsg(t, second) // viewer-list

	h.mu.Lock()
	r := h.rooms["room1"]
	h.mu.Unlock()
	r.mu.Lock()
	got := r.controller
	r.mu.Unlock()
	if got != second {
		t.Fatal("room controller should be the second joiner, not the first")
	}
	if err := first.conn.Close(); err == nil {
		t.Fatal("expected the evicted controller's connection to already be closed")
	}
}

func TestLeaveViewer_NotifiesController(t *testing.T) {
	h := newHub()
	c := h.join("room1", roleController, newTestConn(t))
	recvMsg(t, c) // viewer-list

	v := h.join("room1", roleViewer, newTestConn(t))
	recvMsg(t, v) // peer-joined
	recvMsg(t, c) // peer-joined

	h.leave(v)
	if msg := recvMsg(t, c); msg["kind"] != "peer-left" || msg["from"] != v.id {
		t.Fatalf("controller msg = %v, want peer-left from %s", msg, v.id)
	}
}

func TestLeaveController_NotifiesAllViewers(t *testing.T) {
	h := newHub()
	c := h.join("room1", roleController, newTestConn(t))
	recvMsg(t, c) // viewer-list

	v1 := h.join("room1", roleViewer, newTestConn(t))
	recvMsg(t, v1)
	recvMsg(t, c)
	v2 := h.join("room1", roleViewer, newTestConn(t))
	recvMsg(t, v2)
	recvMsg(t, c)

	h.leave(c)
	for _, v := range []*peer{v1, v2} {
		if msg := recvMsg(t, v); msg["kind"] != "peer-left" || msg["from"] != c.id {
			t.Fatalf("viewer msg = %v, want peer-left from %s", msg, c.id)
		}
	}
}

func TestLeave_EmptyRoomRemovedFromHub(t *testing.T) {
	h := newHub()
	v := h.join("room1", roleViewer, newTestConn(t))
	recvMsg(t, v) // waiting

	h.leave(v)
	h.mu.Lock()
	_, ok := h.rooms["room1"]
	h.mu.Unlock()
	if ok {
		t.Fatal("expected empty room to be removed from hub")
	}
}

func TestSendTo_UnknownPeerIsNoop(t *testing.T) {
	h := newHub()
	r := h.roomFor("room1")
	r.sendTo("nonexistent", []byte(`{"kind":"noop"}`)) // must not panic or block
}

// An evicted controller's read loop calls leave() only once it notices its
// connection was closed — by which time the replacement has registered. If
// leave announced that departure anyway, every viewer would tear down the
// link it had just built to the new controller and hang on "waiting".
func TestLeaveEvictedController_DoesNotAnnounceDeparture(t *testing.T) {
	h := newHub()
	first := h.join("room1", roleController, newTestConn(t))
	recvMsg(t, first) // viewer-list

	v := h.join("room1", roleViewer, newTestConn(t))
	recvMsg(t, v)     // peer-joined (first controller)
	recvMsg(t, first) // peer-joined (viewer)

	second := h.join("room1", roleController, newTestConn(t))
	recvMsg(t, second)                                  // viewer-list
	if msg := recvMsg(t, v); msg["from"] != second.id { // peer-joined (new controller)
		t.Fatalf("viewer msg = %v, want peer-joined from %s", msg, second.id)
	}

	// The evicted controller's read loop now finishes and leaves.
	h.leave(first)

	select {
	case b := <-v.send:
		t.Fatalf("viewer should hear nothing about the evicted controller, got %s", b)
	case <-time.After(100 * time.Millisecond):
	}
}

// sendTo resolves a peer under the room lock and then writes to it without
// holding that lock, so a peer leaving in between must not leave a closed
// channel behind for that write to land on.
func TestSendTo_RacesLeaveWithoutPanicking(t *testing.T) {
	h := newHub()
	c := h.join("room1", roleController, newTestConn(t))
	recvMsg(t, c) // viewer-list

	msg := []byte(`{"kind":"noop"}`)
	for range 50 {
		v := h.join("room1", roleViewer, newTestConn(t))
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			for range 20 {
				v.room.sendTo(v.id, msg)
			}
		}()
		go func() {
			defer wg.Done()
			h.leave(v)
		}()
		wg.Wait()
		// Keep the controller's mailbox from filling and turning later
		// sends into "slow peer" drops.
		for len(c.send) > 0 {
			<-c.send
		}
	}
}

// A peer joining a room at the moment its last occupant leaves must not end
// up in a room the hub has already discarded — it would never be found by
// the next peer to join that room name.
func TestJoinRacesLeave_PeerNeverStrandedInDiscardedRoom(t *testing.T) {
	h := newHub()
	for range 50 {
		v1 := h.join("room1", roleViewer, newTestConn(t))
		recvMsg(t, v1) // waiting

		var wg sync.WaitGroup
		wg.Add(2)
		var v2 *peer
		go func() {
			defer wg.Done()
			h.leave(v1)
		}()
		go func() {
			defer wg.Done()
			v2 = h.join("room1", roleViewer, newTestConn(t))
		}()
		wg.Wait()

		h.mu.Lock()
		reachable := h.rooms["room1"]
		h.mu.Unlock()
		if reachable != v2.room {
			t.Fatal("the surviving viewer is in a room the hub no longer knows about")
		}
		h.leave(v2)
	}
}
