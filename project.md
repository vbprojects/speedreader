Create an Ebook spead reader that uses javascript for front end and backend, is cross platform, and allows users to read from various formats starting with epub and pdf.

Speadreaders will flash sequential words in on a timer, generally aiming for some kind of constant clock speed like 600 words per minute. There needs to be some thought put into how long a word will be flashed for on average which we may need to adjust based on the character length. An additional consideration is that we want to be able to display multiple surrounding words to allow the user to look back or forward while maintaining the correct highlighted word. 

Additionally, we often times will highlight the word in a different color or style to help the reader focus on the current word. We can split the implementation into multiple components with seperation of concerns.

For example, Ingestion Component, this outputs a single stream of words from the input file regardless of format. This stream is cachable and can be given to the distplay format component.