package service

import (
	"fmt"

	"example.com/shop/internal/model"
)

type Client struct {
	base string
	user *models.User
}

// Session embeds a type from another package (qualified embedding).
type Session struct {
	*models.User
	Token string
}

// A second init in the same package, in a different file than handler.go.
func init() {
	defaults = append(defaults, "client")
}

func NewClient(base string, user *models.User) *Client {
	return &Client{base: base, user: user}
}

func (c *Client) Do(path string) (string, error) {
	if c.user == nil {
		return "", fmt.Errorf("no user")
	}
	return c.base + path, nil
}

// Shutdown is a method of Server (declared in server.go).
func (s *Server) Shutdown() {
	s.Stop()
}

func Fetch(base string) string {
	c := NewClient(base, models.NewUser("a", "a@b.c"))
	out, _ := c.Do("/x")
	return out
}

func Greet() string {
	sess := Session{Token: "t"}
	return sess.Display()
}
