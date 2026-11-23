package service

import "fmt"

var defaults []string

// Handler is satisfied implicitly; no implements edge is expected.
type Handler interface {
	Serve(req string) string
}

type Closer interface {
	Close() error
}

// HandlerCloser embeds two interfaces.
type HandlerCloser interface {
	Handler
	Closer
}

type LoggingHandler struct {
	prefix string
}

func (l *LoggingHandler) Serve(req string) string {
	return l.format(req)
}

func (l *LoggingHandler) format(req string) string {
	return fmt.Sprintf("%s%s", l.prefix, req)
}

type EchoHandler struct{}

// The receiver has no name.
func (EchoHandler) Serve(req string) string {
	return req
}

// Dispatch calls through an interface-typed variable: the target is ambiguous
// (LoggingHandler.Serve or EchoHandler.Serve).
func Dispatch(req string) string {
	var h Handler = &LoggingHandler{prefix: "> "}
	return h.Serve(req)
}

func init() {
	defaults = append(defaults, "handler")
}
