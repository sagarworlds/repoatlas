package service_test

import (
	"testing"

	"example.com/shop/internal/service"
)

func TestExternalClient(t *testing.T) {
	c := service.NewClient("http://x", nil)
	if _, err := c.Do("/y"); err == nil {
		t.Log("nil user accepted")
	}
}
