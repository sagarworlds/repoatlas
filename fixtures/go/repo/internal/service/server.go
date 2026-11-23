package service

import (
	"fmt"
	"net/http"

	"example.com/shop/internal/util"
)

type Server struct {
	addr    string
	started bool
	handler Handler
}

// AuditedServer embeds *Server, so Stop is promoted to AuditedServer.
type AuditedServer struct {
	*Server
	Audit []string
}

func NewServer(addr string, h Handler) *Server {
	return &Server{addr: addr, handler: h}
}

func (s *Server) Start() error {
	s.started = true
	s.listen()
	fmt.Println(util.Shout("started " + s.addr))
	return http.ListenAndServe(s.addr, nil)
}

func (s *Server) listen() {
	if s.handler != nil {
		go s.serveLoop()
	}
}

func (s *Server) serveLoop() {
	defer s.Stop()
	reply := s.handler.Serve("ping")
	fmt.Println(reply)
}

func (s *Server) Stop() {
	s.started = false
}

func (a *AuditedServer) Record(msg string) {
	a.Audit = append(a.Audit, msg)
	a.Stop()
}
