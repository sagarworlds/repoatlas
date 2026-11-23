// Package models lives in the directory internal/model: the package name differs
// from the directory name.
package models

import "strings"

// User is a shop customer.
type User struct {
	Name  string
	Email string
}

func NewUser(name, email string) *User {
	return &User{Name: name, Email: email}
}

func (u *User) Validate() bool {
	return strings.Contains(u.Email, "@")
}

func (u *User) Display() string {
	if !u.Validate() {
		return "invalid"
	}
	return normalize(u.Name)
}

// normalize is unexported; util has its own, unrelated normalize.
func normalize(s string) string {
	return strings.TrimSpace(s)
}
