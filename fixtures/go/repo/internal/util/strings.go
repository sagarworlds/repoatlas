package util

import "strings"

func Shout(s string) string {
	return strings.ToUpper(normalize(s)) + "!"
}

// Join shares its name with strings.Join, which it calls.
func Join(parts ...string) string {
	return strings.Join(parts, " ")
}

func normalize(s string) string {
	return strings.TrimSpace(s)
}

// Map is a generic function.
func Map[T, U any](items []T, f func(T) U) []U {
	out := make([]U, 0, len(items))
	for _, item := range items {
		out = append(out, f(item))
	}
	return out
}

// Ping and Pong (in ids.go) call each other across files.
func Ping(n int) int {
	if n <= 0 {
		return 0
	}
	return Pong(n - 1)
}
