package models

import "fmt"

// Admin embeds User, so Display and Validate are promoted to Admin.
type Admin struct {
	User
	Level int
}

func (a *Admin) Promote() {
	a.Level++
	label := a.Display()
	fmt.Println("promoted", label)
}
