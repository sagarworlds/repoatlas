package plugins

import "fmt"

var registered []string

// init runs on import; the blank import in cmd/shop exists only for this.
func init() {
	registered = append(registered, "default")
	fmt.Println("plugins registered")
}

func Registered() []string {
	return registered
}
