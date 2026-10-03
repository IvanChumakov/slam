package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	var m, n int
	fmt.Fscan(in, &m, &n)

	sum := make([]int, n+1)

	for i := 2; i <= n; i++ {
		sum[i] = 1
	}

	for d := 2; d <= n/2; d++ {
		for x := d * 2; x <= n; x += d {
			sum[x] += d
		}
	}

	found := false

	for a := m; a <= n; a++ {
		b := sum[a]

		if a < b && b >= m && b <= n && sum[b] == a {
			fmt.Fprintln(out, a, b)
			found = true
		}
	}

	if !found {
		fmt.Fprintln(out, "Absent")
	}
}