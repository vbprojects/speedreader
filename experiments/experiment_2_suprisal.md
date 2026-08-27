Sparse N-Gram Frequencies with forgetting,

"The quick red fox jumped over the lazy brown dog."

3-grams


# Chunking
The, qui, ck, red, fox, jum, ped, ove, r, the, laz, y, bro, wn, dog, . 

# Normalization
the, qui, ck, red, fox, jum, ped, ove, r, the, laz, y, bro, wn, dog

# Frequencies

| n-gram | Gamma params |
-------------------------
| the | 2, 15 |
| ... | 1, 15 |

Add time discounting, $\gamma$ but we also need to bound the window for a lookback, to something reasonable, maybe we keep track of the last observed word position gamma must be aligned with this number.

Hashmap to entries, cant store every n-gram need to delete entries quickly too, removal after reaching certain infrequent threshold

We scale the length a word is on the screen by the infrequency of its n-grams

We need some assumption for average frequency of n-grams

given the individual frequency of n-grams let us figure out the estimate of the word itself then use the word estimate given the baseline to weight how long the word should be displayed for.

Add the log liklihood of observing an n-gram add the liklihoods. We have a "budget", is this a constrained optimization problem?

We need to map loglikilhoods to wpms, maybe gaussian filter? No we can keep it as exponential gamma to track the distribution we just need to flip the sign.

For some word word at position i we track gamma parameters $\alpha$, $\beta$, last observed position $i_{-1}$, we have globals gamma and i is of course the latest position and can be considered n if we did not include time discounting. At each update we prune the least common n-grams to save space.

Lets consider overlapping n-grams


For some word we calculate the n-grams 

globals
i : index # N-grams overlap, maybe not super well founded but stil
\gamma : gamam
\alpha_e, \beta_e : exponential gamma priors
lnL = 0


for k in range(0, len(word)):
    ngram = word[k:k+3]
    \alpha_k, \beta_k, i_{-1} = table[ngram] # Table should have defaultable values
    deltat = i - i_{i-1}
    window = # some way of calculating the window given gamma, its a formula need to specify a bound or something
    update
    deltat > window -> \alpha_k, \beta_k = assumed value
    deltat < window -> \alpha_k, \beta_k *= gamma * deltat
    lnL += logliklihood(deltat ~ pois ~ gamma(\alpha_k, \beta_k))

scaling = -lnL / E[exponetial ~ gamma(alpha_e, beta_e)]
update -lnL ~ E[exponetial ~ gamma(alpha_e, beta_e)]


should test both exponential gamma and guassian approach



