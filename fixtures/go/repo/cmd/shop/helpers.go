package main

import "fmt"

// worker consumes jobs until the channel is closed.
func worker(jobs chan string) {
	for job := range jobs {
		process(job)
	}
}

func process(job string) {
	// The call to report inside the literal belongs to process.
	handler := func(s string) {
		report(s)
	}
	handler(job)
}

func report(s string) {
	fmt.Println("job:", s)
}

func cleanup() {
	fmt.Println("bye")
}
