package util

import "github.com/google/uuid"

func NewID() string {
	return uuid.NewString()
}

func Pong(n int) int {
	if n <= 0 {
		return 0
	}
	return Ping(n - 1)
}
