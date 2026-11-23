package service

import "testing"

func TestServerStop(t *testing.T) {
	s := NewServer(":0", nil)
	s.Stop()
	if s.started {
		t.Fatal("still started")
	}
}

func TestDispatch(t *testing.T) {
	if Dispatch("x") == "" {
		t.Error("empty reply")
	}
}
