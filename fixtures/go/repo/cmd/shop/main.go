package main

import (
	"fmt"
	"os"
	"time"

	. "example.com/shop/internal/model"
	_ "example.com/shop/internal/plugins"
	"example.com/shop/internal/service"
	u "example.com/shop/internal/util"
)

func main() {
	// Dot import: NewUser and NewOrder are used without a qualifier.
	user := NewUser("ada", "ada@example.com")
	order := NewOrder(user)
	fmt.Println(order.Summary())

	// Composite literal, then a method defined in another file of package service.
	srv := &service.Server{}
	srv.Shutdown()

	// Constructor style: the result type comes from NewServer's signature.
	server := service.NewServer(":8080", nil)
	go worker(make(chan string))
	defer cleanup()

	// Method value passed as an argument: not tracked as a call in v1.
	time.AfterFunc(time.Second, server.Stop)

	if err := server.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	// Aliased import of internal/util.
	fmt.Println(u.Join("done", u.NewID()))
	names := u.Map([]string{"a", "b"}, u.Shout)
	fmt.Println(names)
}
