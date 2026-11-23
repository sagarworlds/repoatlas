package main

import (
	"fmt"

	"example.com/poly/util"
)

func label() string {
	return util.Join("poly", "glot")
}

func main() {
	fmt.Println(label())
}
