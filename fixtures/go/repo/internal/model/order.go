package models

import "fmt"

// ID is a named non-struct type.
type ID int

type Line struct {
	SKU   string
	Qty   int
	Cents int
}

type Order struct {
	ID    ID
	Owner *User
	Lines []Line
}

func NewOrder(owner *User) *Order {
	return &Order{Owner: owner}
}

func (o *Order) Total() int {
	sum := 0
	for _, l := range o.Lines {
		sum += l.Cents * l.Qty
	}
	return sum
}

func (o *Order) Summary() string {
	return fmt.Sprintf("%s: %d", o.Owner.Display(), o.Total())
}

// Orders is a method of User, but User is declared in user.go.
func (u *User) Orders(all []*Order) []*Order {
	if !u.Validate() {
		return nil
	}
	var mine []*Order
	for _, o := range all {
		if o.Owner == u {
			mine = append(mine, o)
		}
	}
	return mine
}
